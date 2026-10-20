package expo.modules.startupdiagnostics

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * Evidence only. No authority, SDK configuration or HTTP policy lives here.
 * Producer work only offers to a bounded queue; parsing/storage use one background thread.
 * Death can lose queued/unflushed events; export reports queue/loss/IO coverage.
 */
object EvidenceTrace {
  private val lock = Any()
  private val process = UUID.randomUUID().toString()
  private val thread by lazy { HandlerThread("kinnship-evidence", android.os.Process.THREAD_PRIORITY_BACKGROUND).apply { start() } }
  private val writer by lazy { Handler(thread.looper) }
  @Volatile private var context: Context? = null
  private lateinit var store: EvidenceStore
  private data class Pending(val channel: String, val stage: String, val id: String, val detail: String,
    val wall: Long, val elapsed: Long)
  private val pending = ArrayBlockingQueue<Pending>(1024)
  private val draining = AtomicBoolean()
  private val queueDropped = AtomicLong()
  private var previousDropped = 0L
  private var writeFailures = 0L
  private var httpOrdinal = 0L
  private var gpsOrdinal = 0L
  private val dirtyHttp = mutableSetOf<Int>()
  private val dirtyGps = mutableSetOf<Int>()
  private val dirtyHours = mutableSetOf<String>()
  @Volatile private var httpObserverStatus = "not_installed"
  @JvmStatic fun httpStatus(status: String) { httpObserverStatus = status }
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
  @JvmStatic fun install(ctx: Context) {
    if (context != null) return
    synchronized(lock) {
      if (context != null) return
      context = ctx.applicationContext
      writer.post {
        store = EvidenceStore(requireNotNull(context).filesDir)
        val restored = store.load()
        // Re-sanitize restored rows; malformed/unknown persisted fields never export.
        fun restore(rows: JSONArray, capacity: Int): JSONArray {
          val clean = JSONArray()
          for (i in 0 until rows.length()) try {
            val row = rows.getJSONObject(i)
            if (row.optString("stage") !in stages || row.getLong("ordinal") < 0) continue
            val processId = row.getString("process")
            if (!Regex("[a-f0-9-]{36}").matches(processId)) continue
            clean.put(JSONObject().put("stage", row.getString("stage")).put("process", processId)
              .put("id", row.optString("id").takeIf { idPattern.matches(it) } ?: "")
              .put("ordinal", row.getLong("ordinal")).put("sequence", row.getLong("sequence"))
              .put("wallClockMs", row.getLong("wallClockMs")).put("elapsedRealtimeMs", row.getLong("elapsedRealtimeMs"))
              .put("detail", sanitize(row.optJSONObject("detail") ?: JSONObject())))
          } catch (_: Exception) { store.readFailures++ }
          return tail(clean, capacity)
        }
        http = restore(restored.first, 512)
        gps = restore(restored.second, 2048)
        hours = store.loadHours { key ->
          val parts = key.split(':')
          key == "counter_overflow" || (parts.size == 3 && parts[0] in stages && parts[1] in sources && parts[2] in reasons)
        }
        httpOrdinal = (0 until http.length()).maxOfOrNull { http.getJSONObject(it).getLong("ordinal") + 1 } ?: 0
        gpsOrdinal = (0 until gps.length()).maxOfOrNull { gps.getJSONObject(it).getLong("ordinal") + 1 } ?: 0
        previousDropped = store.loadLoss()
      }
    }
  }

  @JvmStatic fun record(ctx: Context, channel: String, stage: String, id: String, detail: String) {
    try {
      if (channel !in setOf("http", "gps") || stage !in stages) return
      install(ctx)
      // No disk, JSON parsing, ring copies or authority/worker-lock waits here.
      if (detail.length > 2048 || !pending.offer(Pending(channel, stage, if (id.length == 32) id else "", detail,
          System.currentTimeMillis(), SystemClock.elapsedRealtime()))) queueDropped.incrementAndGet()
      scheduleDrain()
    } catch (_: Exception) { queueDropped.incrementAndGet() }
  }

  private fun scheduleDrain() {
    if (draining.compareAndSet(false, true)) writer.post {
      try {
        // A finite slice lets delayed flush/export work run even under a flood.
        repeat(128) {
          val event = pending.poll() ?: return@repeat
          try { consume(event) } catch (_: Exception) { queueDropped.incrementAndGet() }
        }
      } finally {
        draining.set(false)
        if (!scheduled) {
          scheduled = true
          writer.postDelayed({ flush() }, 1000)
        }
        if (pending.isNotEmpty()) scheduleDrain()
      }
    }
  }

  private fun sanitize(input: JSONObject): JSONObject {
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
        return safe
  }

  private fun consume(event: Pending) {
        val input = JSONObject(event.detail)
        val safe = sanitize(input)
        val source = safe.optString("source", "other")
        val reason = safe.optString("reason", "other")
        val parentId = safe.optString("parentId")
        val now = event.wall
        val elapsed = event.elapsed
        val stage = event.stage
        val safeId = if (idPattern.matches(event.id)) event.id else ""
        val entry = JSONObject().put("wallClockMs", now).put("elapsedRealtimeMs", elapsed)
          .put("process", process).put("sequence", ++sequence).put("stage", stage)
          .put("id", safeId).put("detail", safe)
        if (event.channel == "http") {
          entry.put("ordinal", httpOrdinal++)
          http.put(entry)
          http = tail(http, 512)
          dirtyHttp.add(((httpOrdinal - 1) / 32 % 16).toInt())
        } else {
          // All events count, even when detail sampling declines a busy wake.
          val hour = (now / 3600000L).toString()
          val counters = hours.optJSONObject(hour) ?: JSONObject().also { hours.put(hour, it) }
          val key = "$stage:$source:$reason"
          val boundedKey = if (counters.has(key) || counters.length() < 256) key else "counter_overflow"
          counters.put(boundedKey, counters.optLong(boundedKey) + 1)
          dirtyHours.add(hour)
          val keys = hours.keys().asSequence().toList().sortedBy { it.toLongOrNull() ?: 0 }
          keys.dropLast(48).forEach { hours.remove(it); dirtyHours.remove(it) }
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
            entry.put("ordinal", gpsOrdinal++)
            gps.put(entry)
            gps = tail(gps, 2048)
            dirtyGps.add(((gpsOrdinal - 1) / 32 % 64).toInt())
          }
        }
  }

  private fun tail(rows: JSONArray, capacity: Int): JSONArray {
    if (rows.length() <= capacity) return rows
    return JSONArray().apply { for (i in rows.length() - capacity until rows.length()) put(rows.get(i)) }
  }

  private fun flush() {
    scheduled = false
    try {
      // Only dirty 32-row pages/current hour are rewritten, never the entire ring.
      store.save(http, gps, hours, dirtyHttp, dirtyGps, dirtyHours, previousDropped + queueDropped.get())
      dirtyHttp.clear(); dirtyGps.clear(); dirtyHours.clear()
    } catch (_: Exception) { writeFailures++ }
  }

  @JvmStatic fun read(ctx: Context): String {
    return try {
      install(ctx)
      val result = CompletableFuture<String>()
      writer.post {
        try { result.complete(JSONObject().put("available", true).put("version", 1)
        .put("http", JSONArray(http.toString())).put("gps", JSONArray(gps.toString()))
        .put("hourlyCounts", JSONObject(hours.toString()))
          .put("httpObserverStatus", httpObserverStatus).put("pendingEvents", pending.size)
          .put("queueDropped", previousDropped + queueDropped.get()).put("writeFailures", writeFailures)
          .put("readFailures", store.readFailures)
          .put("limits", "512 HTTP / 2048 sampled GPS rows; 48 hours, 256 counter keys/hour plus overflow; 1024 pending events; buffered/unflushed events may be lost on death; absence is not proof without coverage")
          .toString()) } catch (_: Exception) { result.complete("""{"available":false,"reason":"snapshot_failed"}""") }
      }
      result.get(750, TimeUnit.MILLISECONDS)
    } catch (_: Exception) { """{"available":false,"reason":"observer_busy_or_unavailable"}""" }
  }
}
