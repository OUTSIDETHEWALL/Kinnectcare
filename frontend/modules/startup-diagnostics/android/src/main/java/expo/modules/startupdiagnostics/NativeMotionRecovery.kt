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

  private fun record(c: Context, result: String) {
    val at = System.currentTimeMillis()
    // No recorder/JSON/IO inside the authority-command critical section.
    main.post {
      try {
        prefs(c).edit().putString("lastResult", result).putLong("lastResultAt", at).apply()
        TrackingReliability.record(c, "native_motion_recovery", JSONObject().put("reason", result).toString())
      } catch (_: Exception) { /* observation cannot alter tracking */ }
    }
  }

  fun receiverFailed(c: Context) = record(c, "receiver_failed")

  /** Called only AFTER JS has configured/started the SDK for this exact owner. */
  fun arm(c: Context, owner: String, generation: Long): Boolean {
    if (!permissions(c) || !TrackingReliability.nativeRecoveryBinding(c, owner, generation) {
      check(prefs(c).edit().putString("owner", owner).putLong("generation", generation).commit())
    }) return false
    register(c)
    return true
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
    if (boot) migrateBinding(c)
    if (!eligible(c, snapshot(c))) { record(c, "not_authorized"); finished(); return }
    if (boot) register(c)
    val moving = if (boot) false else {
      if (i.action != ACTION || !ActivityTransitionResult.hasResult(i)) { finished(); return }
      val event = ActivityTransitionResult.extractResult(i)?.transitionEvents?.lastOrNull {
        it.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER &&
          it.activityType in listOf(DetectedActivity.IN_VEHICLE, DetectedActivity.ON_BICYCLE,
            DetectedActivity.ON_FOOT, DetectedActivity.WALKING, DetectedActivity.RUNNING)
      } ?: run { finished(); return }
      val now = SystemClock.elapsedRealtimeNanos()
      if (!NativeMotionPolicy.freshTransition(event.elapsedRealTimeNanos, prefs(c).getLong("lastEvent", 0), now)) {
        record(c, "replayed_transition"); finished(); return
      }
      prefs(c).edit().putLong("lastEvent", event.elapsedRealTimeNanos).apply()
      true
    }
    val s = snapshot(c)
    if (!eligible(c, s)) { record(c, "not_authorized"); finished(); return }
    val owner = s.optString("owner")
    val generation = s.optLong("generation")
    val operation = "native-motion-${UUID.randomUUID()}"
    if (!TrackingReliability.claim(c, owner, generation, operation, System.currentTimeMillis(), true)) {
      record(c, "configuration_busy"); finished(); return
    }
    // Bound BroadcastReceiver lifetime, NOT the SDK mutation quarantine.
    // An overdue SDK callback must never unquarantine a still-pending start.
    val timeout = Handler(Looper.getMainLooper())
    val finish = Runnable { finished() }
    timeout.postDelayed(finish, 8_000)
    var sdk: BackgroundGeolocation? = null
    fun done(result: String) {
      record(c, result)
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
            record(c, "cleanup_failed")
            finished()
          }
        })
      }
      if (!cleanup) finished()
    }
    fun command(action: () -> Unit) {
      if (!permissions(c) || !TrackingReliability.nativeRecoveryCommand(c, owner, generation, operation, action)) stale()
    }
    fun settle(result: String) = command { done(result) }
    try {
      command {
        val instance = BackgroundGeolocation.getInstance(c)
        sdk = instance
        instance.ready(object : TSCallback {
          override fun onSuccess() = command {
            instance.start(object : TSCallback {
              override fun onSuccess() = command {
                if (!moving) settle("boot_start_requested")
                else instance.changePace(true, object : TSCallback {
                  override fun onSuccess() = settle("movement_requested")
                  override fun onFailure(error: String?) = settle("movement_failed")
                })
              }
              override fun onFailure(error: String?) = settle("start_failed")
            })
          }
          override fun onFailure(error: String?) = settle("ready_failed")
        })
      }
    } catch (_: Exception) { settle("start_denied") }
  }

  fun evidence(c: Context): JSONObject = JSONObject()
    .put("available", true).put("lastResult", prefs(c).getString("lastResult", "not_armed"))
    .put("lastResultAt", prefs(c).getLong("lastResultAt", 0))
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
