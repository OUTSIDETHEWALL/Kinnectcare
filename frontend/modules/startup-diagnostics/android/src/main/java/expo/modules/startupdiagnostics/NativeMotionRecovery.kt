package expo.modules.startupdiagnostics

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import com.transistorsoft.locationmanager.adapter.BackgroundGeolocation
import com.transistorsoft.locationmanager.adapter.callback.TSCallback
import com.transistorsoft.locationmanager.config.TSConfig
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID

/**
 * Recovery MUST originate in an Android-exempt event, not an arbitrary JS
 * heartbeat/JobScheduler callback. A Google activity-transition PendingIntent
 * is such an exemption, including after ordinary process death. Registration
 * is independent of the SDK's ActivityRecognitionService that Android denied.
 *
 * No new GPS engine, timer, permission prompt, consent, HTTP client or location
 * storage. The existing SDK and backend consent-generation guards stay in use.
 */
object NativeMotionRecovery {
  private const val ACTION = "app.kinnship.client.NATIVE_MOTION_RECOVERY"
  private val main = Handler(Looper.getMainLooper())
  private fun prefs(c: Context) = c.getSharedPreferences("kinnship_native_motion_recovery_v1", Context.MODE_PRIVATE)
  private fun snapshot(c: Context) = JSONObject(TrackingReliability.read(c))
  private fun permissions(c: Context): Boolean =
    c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED &&
      (Build.VERSION.SDK_INT < 29 ||
        (c.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED &&
          c.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED))

  private fun eligible(c: Context, s: JSONObject): Boolean = NativeMotionPolicy.allowed(
    s.optString("owner"), s.optLong("generation", -1), s.optBoolean("revoked", true),
    s.optBoolean("shutdownPending", false) || (s.optJSONObject("shutdowns")?.length() ?: 0) > 0,
    s.has("pendingMutation"), prefs(c).getString("owner", "") ?: "",
    prefs(c).getLong("generation", -1), permissions(c))

  private fun intent(c: Context): PendingIntent = PendingIntent.getBroadcast(c, 719,
    Intent(c, NativeMotionReceiver::class.java).setAction(ACTION),
    PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0))

  private fun record(c: Context, result: String, operation: String = "", trigger: String = "",
    activity: Int = -1, ageMs: Long = -1, error: String? = null) {
    val at = System.currentTimeMillis()
    val elapsed = SystemClock.elapsedRealtime()
    val failed = result.endsWith("_failed") || result == "start_denied"
    val failureCategory = if (failed) NativeRecoveryFailure.category(error) else null
    val sdkCode = if (failed) NativeRecoveryFailure.code(error) else null
    // No recorder/JSON/IO inside the authority-command critical section.
    main.post {
      try {
        val p = prefs(c)
        val edit = p.edit().putString("lastResult", result).putLong("lastResultAt", at)
        if (operation.isEmpty()) {
          // Registration acknowledgments must not erase the recovery outcome.
          edit.putString("lastRegistrationResult", result).putLong("lastRegistrationAt", at)
        } else {
          val attempts = JSONArray(p.getString("attempts", "[]"))
          var attempt: JSONObject? = null
          for (index in 0 until attempts.length()) {
            if (attempts.getJSONObject(index).optString("operation") == operation) {
              attempt = attempts.getJSONObject(index)
              break
            }
          }
          if (attempt == null) {
            attempt = JSONObject().put("operation", operation).put("trigger", trigger)
              .put("receivedAt", at).put("stages", JSONArray())
            attempts.put(attempt)
          }
          if (activity >= 0) attempt.put("activity", activity).put("transitionAgeMs", ageMs)
          val stages = attempt.getJSONArray("stages")
          val stage = JSONObject().put("stage", result).put("at", at).put("elapsedMs", elapsed)
          if (failureCategory != null) stage.put("failureCategory", failureCategory)
          if (sdkCode != null) stage.put("sdkCode", sdkCode)
          stages.put(stage)
          val boundedStages = JSONArray()
          for (index in maxOf(0, stages.length() - 24) until stages.length()) boundedStages.put(stages.get(index))
          attempt.put("stages", boundedStages).put("lastStage", result).put("lastStageAt", at)
          val boundedAttempts = JSONArray()
          for (index in maxOf(0, attempts.length() - 16) until attempts.length()) boundedAttempts.put(attempts.get(index))
          edit.putString("attempts", boundedAttempts.toString())
            .putString("lastRecoveryResult", result).putLong("lastRecoveryAt", at)
        }
        edit.apply()
        TrackingReliability.record(c, "native_motion_recovery", JSONObject().put("reason", result).toString())
      } catch (_: Exception) { /* observation cannot alter tracking */ }
    }
  }

  fun receiverFailed(c: Context) = record(c, "receiver_failed", "native-motion-${UUID.randomUUID()}", "receiver")

  /** Called only AFTER JS has configured/started the SDK for this exact owner. */
  fun arm(c: Context, owner: String, generation: Long): Boolean {
    if (!permissions(c) || !TrackingReliability.nativeRecoveryBinding(c, owner, generation) {
      check(prefs(c).edit().putString("owner", owner).putLong("generation", generation).commit())
    }) return false
    register(c)
    return true
  }

  /**
   * Re-register the existing transition PendingIntent, not the location service.
   * Registration does NOT start an FGS or force changePace(true). Only a real,
   * fresh activity transition may enter the existing exempt recovery path.
   * Claim the maintenance budget under the same cross-runtime authority lock;
   * retain it even if Play Services fails/never invokes its callback.
   */
  fun maintain(c: Context, owner: String, generation: Long): String {
    if (!permissions(c)) return "permission_unverified"
    val result = TrackingReliability.claimMotionMaintenance(c, owner, generation, System.currentTimeMillis()) {
      check(prefs(c).edit().putString("owner", owner).putLong("generation", generation).commit())
    }
    if (result != "requested") return result
    return try {
      register(c)
      record(c, "maintenance_requested")
      result
    } catch (_: Exception) {
      record(c, "maintenance_failed")
      "failed"
    }
  }

  /** Package upgrade must not require mounting the UI to adopt a valid legacy
   * installation. Absence is NOT consent: require the existing native owner,
   * live grants, and that owner's persisted SDK transport/lifecycle settings. */
  private fun migrateBinding(c: Context) {
    if (!prefs(c).getString("owner", "").isNullOrEmpty() || !permissions(c)) return
    val s = snapshot(c)
    val owner = s.optString("owner")
    val parts = owner.split(":")
    if (parts.size != 2 || parts.any { it.isBlank() } || s.optBoolean("revoked", true)) return
    val config = TSConfig.getInstance(c).toJson(false)
    val uri = android.net.Uri.parse(config.optString("url"))
    if (uri.scheme != "https" || uri.host.isNullOrEmpty() || uri.query != null || uri.fragment != null ||
      uri.path != "/api/members/${parts[1]}/location" || !config.optBoolean("startOnBoot", false) ||
      !config.optBoolean("enableHeadless", false) || config.optBoolean("stopOnTerminate", true)) return
    TrackingReliability.nativeRecoveryBinding(c, owner, s.optLong("generation", -1)) {
      check(prefs(c).edit().putString("owner", owner).putLong("generation", s.optLong("generation")).commit())
    }
  }

  fun register(c: Context) {
    if (!eligible(c, snapshot(c))) { record(c, "not_authorized"); return }
    val activities = listOf(DetectedActivity.IN_VEHICLE, DetectedActivity.ON_BICYCLE,
      DetectedActivity.ON_FOOT, DetectedActivity.WALKING, DetectedActivity.RUNNING)
    val transitions = activities.map {
      ActivityTransition.Builder().setActivityType(it)
        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER).build()
    }
    ActivityRecognition.getClient(c).requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), intent(c))
      .addOnSuccessListener { record(c, "registered") }
      .addOnFailureListener { record(c, "registration_failed") }
  }

  fun receive(c: Context, i: Intent, finished: () -> Unit) {
    val boot = i.action == Intent.ACTION_BOOT_COMPLETED || i.action == Intent.ACTION_MY_PACKAGE_REPLACED
    val operation = "native-motion-${UUID.randomUUID()}"
    val trigger = when (i.action) {
      Intent.ACTION_BOOT_COMPLETED -> "boot"
      Intent.ACTION_MY_PACKAGE_REPLACED -> "package_replaced"
      else -> "motion"
    }
    fun trace(result: String, error: String? = null) =
      record(c, result, operation, trigger, error = error)
    trace("receiver_received")
    if (boot) migrateBinding(c)
    if (!eligible(c, snapshot(c))) { trace("not_authorized"); finished(); return }
    if (boot) register(c)
    val moving = if (boot) false else {
      if (i.action != ACTION || !ActivityTransitionResult.hasResult(i)) { trace("transition_missing"); finished(); return }
      val event = ActivityTransitionResult.extractResult(i)?.transitionEvents?.lastOrNull {
        it.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER &&
          it.activityType in listOf(DetectedActivity.IN_VEHICLE, DetectedActivity.ON_BICYCLE,
            DetectedActivity.ON_FOOT, DetectedActivity.WALKING, DetectedActivity.RUNNING)
      } ?: run { trace("movement_transition_missing"); finished(); return }
      val now = SystemClock.elapsedRealtimeNanos()
      record(c, "transition_received", operation, trigger, event.activityType,
        (now - event.elapsedRealTimeNanos) / 1_000_000)
      if (!NativeMotionPolicy.freshTransition(event.elapsedRealTimeNanos, prefs(c).getLong("lastEvent", 0), now)) {
        trace("replayed_transition"); finished(); return
      }
      trace("transition_accepted")
      prefs(c).edit().putLong("lastEvent", event.elapsedRealTimeNanos).apply()
      true
    }
    val s = snapshot(c)
    if (!eligible(c, s)) { trace("not_authorized"); finished(); return }
    val owner = s.optString("owner")
    val generation = s.optLong("generation")
    if (!TrackingReliability.claim(c, owner, generation, operation, System.currentTimeMillis(), true)) {
      trace("configuration_busy"); finished(); return
    }
    trace("configuration_claimed")
    // Bound BroadcastReceiver lifetime, NOT the SDK mutation quarantine.
    // An overdue SDK callback must never unquarantine a still-pending start.
    val timeout = Handler(Looper.getMainLooper())
    val finish = Runnable { trace("receiver_timeout"); finished() }
    timeout.postDelayed(finish, 8_000)
    var sdk: BackgroundGeolocation? = null
    fun done(result: String, error: String? = null) {
      trace(result, error)
      TrackingReliability.complete(c, operation, "operation_discarded", 0, false)
      timeout.removeCallbacks(finish)
      finished()
    }
    fun stale() {
      val instance = sdk
      if (instance == null) { done("obsolete_owner"); return }
      val cleanup = TrackingReliability.nativeRecoveryCleanup(c, operation) {
        instance.stop(object : TSCallback {
          override fun onSuccess() = done("obsolete_owner_stopped")
          override fun onFailure(error: String?) {
            // Retain quarantine: an unconfirmed stop cannot authorize rebind.
            trace("cleanup_failed", error)
            finished()
          }
        })
      }
      if (!cleanup) { trace("cleanup_not_admitted"); finished() }
    }
    fun command(action: () -> Unit) {
      if (!permissions(c) || !TrackingReliability.nativeRecoveryCommand(c, owner, generation, operation, action)) {
        trace("command_not_admitted")
        stale()
      }
    }
    fun settle(result: String, error: String? = null) = command { done(result, error) }
    try {
      command {
        val instance = BackgroundGeolocation.getInstance(c)
        sdk = instance
        trace("ready_requested")
        instance.ready(object : TSCallback {
          override fun onSuccess() = command {
            trace("ready_succeeded")
            trace("start_requested")
            instance.start(object : TSCallback {
              override fun onSuccess() = command {
                trace("start_succeeded")
                if (!moving) settle("boot_start_requested")
                else {
                  trace("change_pace_requested")
                  instance.changePace(true, object : TSCallback {
                    override fun onSuccess() = settle("movement_requested")
                    override fun onFailure(error: String?) = settle("movement_failed", error)
                  })
                }
              }
              override fun onFailure(error: String?) = settle("start_failed", error)
            })
          }
          override fun onFailure(error: String?) = settle("ready_failed", error)
        })
      }
    } catch (error: Exception) { settle("start_denied", error.javaClass.simpleName) }
  }

  fun evidence(c: Context): JSONObject = JSONObject()
    .put("available", true).put("lastResult", prefs(c).getString("lastResult", "not_armed"))
    .put("lastResultAt", prefs(c).getLong("lastResultAt", 0))
    .put("lastRegistrationResult", prefs(c).getString("lastRegistrationResult", "unknown"))
    .put("lastRegistrationAt", prefs(c).getLong("lastRegistrationAt", 0))
    .put("lastRecoveryResult", prefs(c).getString("lastRecoveryResult", "unknown"))
    .put("lastRecoveryAt", prefs(c).getLong("lastRecoveryAt", 0))
    .put("attempts", JSONArray(prefs(c).getString("attempts", "[]")))
}

open class NativeMotionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val result = goAsync()
    val finished = java.util.concurrent.atomic.AtomicBoolean(false)
    try { NativeMotionRecovery.receive(context.applicationContext, intent) {
      if (finished.compareAndSet(false, true)) result.finish()
    } } catch (_: Exception) {
      NativeMotionRecovery.receiverFailed(context.applicationContext)
      if (finished.compareAndSet(false, true)) result.finish()
    }
  }
}

class NativeMotionBootReceiver : NativeMotionReceiver()
