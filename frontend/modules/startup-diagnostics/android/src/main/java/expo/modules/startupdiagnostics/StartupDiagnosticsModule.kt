package expo.modules.startupdiagnostics

import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * Local diagnostics and synchronous tracking safety APIs. Observational writes
 * contain their failures; operational lifetime queries remain memory-only.
 */
class StartupDiagnosticsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StartupDiagnostics")

    Function("headlessTaskCurrent") { token: String -> HeadlessTaskLifetimes.current(token) }
    Function("headlessTaskEnd") { token: String -> HeadlessTaskLifetimes.end(token) }

    Function("originVersion") { 1 }
    Function("originBind") { request: Int, detail: String ->
      appContext.reactContext?.let { RequestOrigins.install(it); RequestOrigins.bind(it, request, detail) }
    }
    Function("originRecord") { kind: String, id: String, stage: String, detail: String ->
      appContext.reactContext?.let { RequestOrigins.install(it); RequestOrigins.record(kind, id, stage, detail) }
    }
    Function("deepRecord") { kind: String, id: String, stage: String, detail: String ->
      appContext.reactContext?.let { DeepAsyncTrace.install(it) }
      DeepAsyncTrace.record(kind, id, stage, detail)
    }
    Function("deepBindRequest") { request: Int, id: String ->
      appContext.reactContext?.let { DeepAsyncTrace.bind(it, request, id) }
    }
    Function("deepBodyBind") { blob: String, request: String -> DeepAsyncTrace.bodyBind(blob, request) }
    Function("deepRead") { DeepAsyncTrace.read() }
    Function("originRead") {
      appContext.reactContext?.let { RequestOrigins.install(it) }
      RequestOrigins.read()
    }

    Function("evidenceVersion") { 1 }
    Function("evidenceRecord") { channel: String, stage: String, id: String, detail: String ->
      appContext.reactContext?.let { EvidenceTrace.record(it, channel, stage, id, detail) }
    }
    Function("evidenceRead") {
      appContext.reactContext?.let { EvidenceTrace.read(it) } ?: """{"available":false}"""
    }

    Function("trackingRead") {
      TrackingReliability.read(requireNotNull(appContext.reactContext))
    }
    Function("trackingAuthorize") { owner: String, generation: Long ->
      TrackingReliability.authorize(requireNotNull(appContext.reactContext), owner, generation)
    }
    Function("trackingRevoke") { reason: String ->
      TrackingReliability.revoke(requireNotNull(appContext.reactContext), reason)
    }
    Function("trackingRevokeIfCurrent") { owner: String, generation: Long, reason: String, operation: String ->
      TrackingReliability.revokeIfCurrent(requireNotNull(appContext.reactContext), owner, generation, reason, operation)
    }
    Function("trackingRearmConsent") { generation: Long ->
      TrackingReliability.rearmConsent(requireNotNull(appContext.reactContext), generation)
    }
    Function("trackingClaim") { owner: String, generation: Long, operation: String, now: Long ->
      TrackingReliability.claim(requireNotNull(appContext.reactContext), owner, generation, operation, now)
    }
    Function("trackingClaimEvidence") { owner: String, generation: Long, operation: String, now: Long, evidenceId: String ->
      TrackingReliability.claim(requireNotNull(appContext.reactContext), owner, generation, operation, now, false, evidenceId)
    }
    Function("trackingClaimConfiguration") { owner: String, generation: Long, operation: String, now: Long ->
      TrackingReliability.claim(requireNotNull(appContext.reactContext), owner, generation, operation, now, true)
    }
    Function("trackingComplete") { operation: String, outcome: String, capturedAt: Long, moving: Boolean ->
      TrackingReliability.complete(requireNotNull(appContext.reactContext), operation, outcome, capturedAt, moving)
    }
    Function("trackingRecord") { event: String, detail: String ->
      TrackingReliability.record(requireNotNull(appContext.reactContext), event, detail)
    }
    Function("trackingEvidence") {
      TrackingReliability.evidence(requireNotNull(appContext.reactContext))
    }
    Function("trackingObserve") { owner: String, generation: Long, capturedAt: Long, moving: Boolean ->
      TrackingReliability.observe(requireNotNull(appContext.reactContext), owner, generation, capturedAt, moving)
    }
    Function("trackingMovement") { owner: String, generation: Long, moving: Boolean ->
      TrackingReliability.movement(requireNotNull(appContext.reactContext), owner, generation, moving)
    }
    Function("trackingShutdownComplete") { generation: Long ->
      TrackingReliability.shutdownComplete(requireNotNull(appContext.reactContext), generation)
    }
    Function("trackingShutdownBegin") { generation: Long, operation: String ->
      TrackingReliability.shutdownBegin(requireNotNull(appContext.reactContext), generation, operation)
    }
    Function("trackingShutdownEnd") { operation: String, success: Boolean ->
      TrackingReliability.shutdownEnd(requireNotNull(appContext.reactContext), operation, success)
    }

    Function("record") { event: String, metadataJson: String? ->
      val context = appContext.reactContext ?: return@Function false
      StartupDiagnosticsRecorder.record(context, event, metadataJson)
    }

    Function("read") {
      val context = appContext.reactContext ?: return@Function """{"records":[]}"""
      StartupDiagnosticsRecorder.read(context)
    }

    Function("clear") {
      val context = appContext.reactContext ?: return@Function false
      StartupDiagnosticsRecorder.clear(context)
    }
  }
}

object StartupDiagnosticsRecorder {
  private const val PREFS = "kinnship_startup_diagnostics_v1"
  private const val RECORDS = "records"
  private const val LATEST = "latest"
  private const val RUN_ID = "run_id"
  private const val NEXT_SEQUENCE = "next_sequence"
  private const val CAPACITY = 100
  private val lock = Any()

  @Volatile
  private var runId: String? = null

  // Exact inventory of current JS caller metadata keys. Do not infer safety
  // from a key name: unlisted keys are intentionally discarded.
  private val allowedMetadataKeys = setOf(
    "authenticated",
    "pathnameObserved",
    "coldStart",
    "urlPresent",
    "invitePresent",
    "accepted",
    "alreadyConsumed",
    "persistenceFailed",
    "android"
  )

  @JvmStatic
  fun startNewRun(context: Context) {
    try {
      synchronized(lock) {
        runId = UUID.randomUUID().toString()
        // commit is intentional: process death immediately after this call retains the run.
        preferences(context).edit().putString(RUN_ID, runId).commit()
      }
    } catch (_: Exception) {
      // Diagnostics must never throw into Application.onCreate.
    }
  }

  @JvmStatic
  fun record(context: Context, event: String?, metadataJson: String?): Boolean {
    return try {
      synchronized(lock) {
        val prefs = preferences(context)
        if (runId == null) {
          runId = prefs.getString(RUN_ID, null)
          if (runId == null) {
            startNewRun(context)
          }
        }

        val records = JSONArray(prefs.getString(RECORDS, "[]"))
        val sequence = prefs.getLong(NEXT_SEQUENCE, 0L) + 1L
        val entry = JSONObject().apply {
          put("wallClockMs", System.currentTimeMillis())
          put("elapsedRealtimeMs", SystemClock.elapsedRealtime())
          put("runId", runId)
          put("sequence", sequence)
          put("event", sanitizeEvent(event))
          sanitizeMetadata(metadataJson).takeIf { it.length() > 0 }?.let { put("metadata", it) }
        }
        records.put(entry)
        val bounded = JSONArray()
        for (index in maxOf(0, records.length() - CAPACITY) until records.length()) {
          bounded.put(records.getJSONObject(index))
        }

        // A single synchronous commit keeps record history and authoritative latest consistent.
        prefs.edit()
          .putString(RECORDS, bounded.toString())
          .putString(LATEST, entry.toString())
          .putLong(NEXT_SEQUENCE, sequence)
          .commit()
      }
    } catch (_: Exception) {
      false
    }
  }

  @JvmStatic
  fun read(context: Context): String {
    return try {
      val prefs = preferences(context)
      JSONObject().apply {
        put("records", JSONArray(prefs.getString(RECORDS, "[]")))
        prefs.getString(LATEST, null)?.let { put("latest", JSONObject(it)) }
      }.toString()
    } catch (_: Exception) {
      """{"records":[]}"""
    }
  }

  @JvmStatic
  fun clear(context: Context): Boolean {
    return try {
      // Retain run and sequence so a post-clear checkpoint remains correctly ordered.
      preferences(context).edit().remove(RECORDS).remove(LATEST).commit()
    } catch (_: Exception) {
      false
    }
  }

  private fun preferences(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun sanitizeEvent(event: String?): String =
    (event ?: "invalid_event").replace(Regex("[^a-zA-Z0-9_.-]"), "_").take(80)

  private fun sanitizeMetadata(raw: String?): JSONObject {
    val safe = JSONObject()
    if (raw == null || raw.length > 1024) return safe
    try {
      val input = JSONObject(raw)
      input.keys().asSequence().take(8).forEach { key ->
        val value = input.opt(key)
        if (
          key in allowedMetadataKeys &&
          (value is Boolean || value is Number)
        ) {
          safe.put(key, value)
        }
      }
    } catch (_: Exception) {
      // Invalid metadata is omitted rather than affecting the caller.
    }
    return safe
  }
}