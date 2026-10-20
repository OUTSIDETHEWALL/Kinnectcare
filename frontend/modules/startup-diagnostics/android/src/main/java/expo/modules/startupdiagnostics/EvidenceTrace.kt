package expo.modules.startupdiagnostics

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * Evidence only. No authority, SDK configuration or HTTP policy lives here.
 * Producer work is bounded in-memory; disk writes run on a dedicated thread.
 * Abrupt process death can lose the final unflushed second (reported on export).
 */
object EvidenceTrace {
  private val lock = Any()
  private val process = UUID.randomUUID().toString()
  private val thread by lazy { HandlerThread("kinnship-evidence").apply { start() } }
  private val writer by lazy { Handler(thread.looper) }
  private var context: Context? = null
  private var scheduled = false
  private var sequence = 0L
  private var http = JSONArray()
  private var gps = JSONArray()
  private var hours = JSONObject()
  private val sampledWakes = linkedSetOf<String>()
  private val lastSamples = mutableMapOf<String, Long>()
  private val idPattern = Regex("[a-f0-9]{32}")
  private val stages = setOf(
    "js_adapter_started", "js_adapter_settled", "native_call_start", "dispatcher_entered",
    "dns_start", "dns_end", "connect_start", "tls_start", "tls_end", "connect_end",
    "connect_failed", "connection_acquired", "request_headers_start", "request_headers_end",
    "request_body_start", "request_body_end", "response_headers_start", "response_headers_end",
    "response_body_start", "response_body_end", "native_call_end", "native_call_failed",
    "native_wake_received", "native_task_queued", "native_context_requested",
    "native_context_ready", "native_task_invoke", "native_task_finished", "native_task_error", "native_task_skipped",
    "js_wake_received", "authorization_result", "claim_decision", "configuration_claim_decision", "native_gps_requested",
    "gps_callback_received", "gps_callback_failed", "publication_attempt", "publication_result",
    "acquisition_completed"
  )
  private val sources = setOf("heartbeat", "terminate", "boot", "motionchange", "activitychange",
    "location", "workmanager", "other")
  private val reasons = setOf("allowed", "revoked", "generation_mismatch", "owner_mismatch",
    "mutation_pending", "shutdown_pending", "lease_active", "backoff", "capture_recent",
    "ownership_unavailable", "authorization_unverified", "authorization_obsolete", "sharing_disabled",
    "invalid_owner", "session_rejected", "permission_denied", "no_session", "invalid_backend",
    "obsolete_owner", "authenticated_owner", "native_unavailable", "other")
  private fun prefs(ctx: Context) = ctx.getSharedPreferences("kinnship_bounded_evidence_v1", Context.MODE_PRIVATE)

  @JvmStatic fun install(ctx: Context) {
    synchronized(lock) {
      if (context != null) return
      context = ctx.applicationContext
      try {
        val p = prefs(ctx)
        http = JSONArray(p.getString("http", "[]"))
        gps = JSONArray(p.getString("gps", "[]"))
        hours = JSONObject(p.getString("hours", "{}"))
      } catch (_: Exception) { /* corrupt evidence is not tracking authority */ }
    }
  }

  @JvmStatic fun record(ctx: Context, channel: String, stage: String, id: String, detail: String) {
    try {
      if (channel !in setOf("http", "gps") || stage !in stages) return
      install(ctx)
      synchronized(lock) {
        val input = JSONObject(detail)
        val safe = JSONObject()
        for (key in listOf("generation", "expectedGeneration", "captureAgeMs", "leaseAgeMs",
          "backoffRemainingMs", "status", "queued", "running", "bytes", "taskId", "accepted")) {
          val value = input.opt(key)
          if (value is Number || value is Boolean) safe.put(key, value)
        }
        val source = input.optString("source").removePrefix("sdk-").let { if (it in sources) it else "other" }
        if (input.has("source")) safe.put("source", source)
        val reason = input.optString("reason").let { if (it in reasons) it else "other" }
        if (input.has("reason")) safe.put("reason", reason)
        val edgeId = input.optString("edgeId")
        if (Regex("[A-Za-z0-9_-]{1,128}").matches(edgeId)) safe.put("edgeId", edgeId)
        val parentId = input.optString("parentId")
        if (idPattern.matches(parentId)) safe.put("parentId", parentId)
        val now = System.currentTimeMillis()
        val elapsed = SystemClock.elapsedRealtime()
        val safeId = if (idPattern.matches(id)) id else ""
        val entry = JSONObject().put("wallClockMs", now).put("elapsedRealtimeMs", elapsed)
          .put("process", process).put("sequence", ++sequence).put("stage", stage)
          .put("id", safeId).put("detail", safe)
        if (channel == "http") {
          http.put(entry)
          http = tail(http, 512)
        } else {
          // All events count, even when detail sampling declines a busy wake.
          val hour = (now / 3600000L).toString()
          val counters = hours.optJSONObject(hour) ?: JSONObject().also { hours.put(hour, it) }
          val key = "$stage:$source:$reason"
          counters.put(key, counters.optLong(key) + 1)
          val keys = hours.keys().asSequence().toList().sorted()
          keys.dropLast(48).forEach { hours.remove(it) }
          if (stage == "native_wake_received" && safeId.isNotEmpty()) {
            val last = lastSamples[source]
            if (last == null || elapsed - last >= 15 * 60000L) {
              lastSamples[source] = elapsed
              sampledWakes.add(safeId)
              while (sampledWakes.size > 128) sampledWakes.remove(sampledWakes.first())
            }
          }
          if (parentId in sampledWakes && safeId.isNotEmpty()) {
            sampledWakes.add(safeId)
            while (sampledWakes.size > 128) sampledWakes.remove(sampledWakes.first())
          }
          // Non-wake claim/publication evidence is sampled per stage/reason,
          // not per coordinate, member or arbitrary string.
          val sampleKey = "$stage:$reason"
          val last = lastSamples[sampleKey]
          if (safeId in sampledWakes || last == null || elapsed - last >= 15 * 60000L) {
            lastSamples[sampleKey] = elapsed
            gps.put(entry)
            gps = tail(gps, 2048)
          }
        }
        if (!scheduled) {
          scheduled = true
          writer.postDelayed({ flush() }, 1000)
        }
      }
    } catch (_: Exception) { /* never affect a decision, task or response */ }
  }

  private fun tail(rows: JSONArray, capacity: Int): JSONArray {
    if (rows.length() <= capacity) return rows
    return JSONArray().apply { for (i in rows.length() - capacity until rows.length()) put(rows.get(i)) }
  }

  private fun flush() {
    // Serialize writers; do not hold the producer lock during disk IO.
    val snapshot = synchronized(lock) {
      scheduled = false
      arrayOf(http.toString(), gps.toString(), hours.toString())
    }
    try {
      context?.let { prefs(it).edit().putString("http", snapshot[0])
        .putString("gps", snapshot[1]).putString("hours", snapshot[2]).commit() }
    } catch (_: Exception) { /* export states best-effort durability */ }
  }

  @JvmStatic fun read(ctx: Context): String {
    install(ctx)
    return synchronized(lock) {
      JSONObject().put("available", true).put("version", 1)
        .put("http", JSONArray(http.toString())).put("gps", JSONArray(gps.toString()))
        .put("hourlyCounts", JSONObject(hours.toString()))
        .put("limits", "512 HTTP / 2048 sampled GPS rows; 48 hourly counter buckets; final unflushed second may be lost; absence is not proof without coverage")
        .toString()
    }
  }
}
