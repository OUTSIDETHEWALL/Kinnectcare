package expo.modules.startupdiagnostics

import android.content.Context
import android.os.SystemClock
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import okhttp3.Call
import okhttp3.Dispatcher
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

/** Compact, local-only observer. Producers never parse JSON, restore or write disk. */
object RequestOrigins {
  const val REQUEST_CAPACITY = 512
  const val OTHER_CAPACITY = 256
  const val QUEUE_CAPACITY = 2048
  private const val MAX_FILE_BYTES = 2 * 1024 * 1024
  private val process = UUID(System.currentTimeMillis(), System.nanoTime()).toString().replace("-", "")
  private val ordinal = AtomicLong()
  private val dropped = AtomicLong()
  private val bindingDropped = AtomicLong()
  private val draining = AtomicBoolean()
  private val installed = AtomicBoolean()
  private val writer = RecorderWorker("kinnship-origins")
  @JvmStatic fun startWorker() {
    if (writer.start()) { draining.set(false); if (pending.isNotEmpty()) schedule() }
  }
  private data class Event(val kind: String, val id: String, val stage: String, val detail: String,
    val elapsed: Long, val wall: Long, val sequence: Long)
  data class Tag(val id: String, val detail: String)
  private val pending = RecorderQueue<Event>(QUEUE_CAPACITY)
  private data class Binding(val tag: Tag, val count: Int = 1, val ambiguous: Boolean = false)
  private val bindings = RecorderMap<Int, Binding>(REQUEST_CAPACITY) { bindingDropped.incrementAndGet() }
  private val calls = RecorderMap<Call, Tag>(REQUEST_CAPACITY) { bindingDropped.incrementAndGet() }
  private val queuePeaks = RecorderMap<Int, AtomicInteger>(8) { bindingDropped.incrementAndGet() }
  // Writer-thread-only state. Compact records update in place, not one row per stage.
  private val requests = linkedMapOf<String, JSONObject>()
  private val operations = linkedMapOf<String, JSONObject>()
  private val tasks = linkedMapOf<String, JSONObject>()
  private val bursts = linkedMapOf<String, JSONObject>()
  private val counts = linkedMapOf<String, Long>()
  private var evicted = 0L
  private var priorDropped = 0L
  private var priorBindingDropped = 0L
  private var failures = 0L
  private var restoreFailures = 0L
  private var flushScheduled = false
  private var file: File? = null
  @Volatile private var cachedSnapshot = """{"available":false,"reason":"observer_initializing"}"""
  private val fields = setOf("operation", "origin", "phase", "wake", "generation", "runtime", "request",
    "endpoint", "method", "taskId", "reactTaskId", "context", "timeoutMs", "queued", "running", "dispatcher", "reason", "trigger",
    "queueMissing", "queueTruncated")
  private val stages = setOf("created", "native_start", "entered", "ended", "failed", "canceled",
    "js_settled", "queued", "invoked", "removed", "timeout", "finish_requested", "missing_finish")

  @JvmStatic fun install(context: Context) {
    if (!installed.compareAndSet(false, true)) return
    if (!writer.initialize {
      try { file = File(context.applicationContext.filesDir, "request-origins-v1.json"); restore() }
      catch (_: Throwable) { restoreFailures++ }
      cachedSnapshot = snapshot().toString()
    }) { installed.set(false); dropped.incrementAndGet() }
  }

  @JvmStatic fun bind(context: Context, request: Int, detail: String) {
    if (detail.length > 768) { bindingDropped.incrementAndGet(); return }
    val tag = Tag("$process-${ordinal.incrementAndGet()}", detail)
    // RN IDs can restart on runtime recreation. Ambiguous associations are NEVER
    // guessed; all colliding pending bindings are explicitly unattributed.
    val admitted = bindings.compute(request) { _, previous ->
      if (previous != null) Binding(previous.tag, previous.count + 1, true)
      else Binding(tag)
    }
    if (admitted != null) record("request", tag.id, "created",
      detail.dropLast(1) + ""","context":${System.identityHashCode(context)}}""")
  }

  /** Associate at Call construction, without changing RN's Request or cancel tag. */
  fun begin(call: Call): Tag? {
    var found: Tag? = null
    val requestId = call.request().tag() as? Int
    if (requestId != null) {
      val binding = bindings.computePrevious(requestId) { _, previous ->
        if (previous != null && previous.count > 1) previous.copy(count = previous.count - 1) else null
      }
      if (binding != null) {
        if (!binding.ambiguous) found = binding.tag else bindingDropped.incrementAndGet()
      }
    }
    if (!call.request().url.encodedPath.startsWith("/api/")) return null
    val tag = found ?: Tag("$process-${ordinal.incrementAndGet()}", """{"origin":"unattributed"}""")
    calls[call] = tag
    return tag
  }
  fun tag(call: Call): Tag? = calls[call]
  fun finish(call: Call) { calls.remove(call) }

  /** Exact local queue membership at rising peaks, not inferred from callStart.
   * At most eight dispatcher counters; one compact retained snapshot each.
   * Codes are native ID suffixes, joined with this row's process ID on export.
   */
  fun census(dispatcher: Dispatcher) {
    val count = dispatcher.queuedCallsCount()
    if (count < 16) return
    val identity = System.identityHashCode(dispatcher)
    val peak = queuePeaks[identity] ?: run {
      val candidate = AtomicInteger()
      val existing = queuePeaks.putIfAbsent(identity, candidate)
      existing ?: candidate
    }
    // Stop census work after the retained-ID limit; do not repeatedly copy a
    // pathological dispatcher queue. Report that limit rather than imply coverage.
    val observed = minOf(count, 129)
    var previous = peak.get()
    while (observed > previous) {
      if (peak.compareAndSet(previous, observed)) {
        val queued = if (count <= 128) dispatcher.queuedCalls() else emptyList()
        val selected = queued.take(128)
        var missing = 0
        val codes = selected.joinToString(" ") {
          val tag = calls[it]
          if (tag == null) { missing++; "0" } else tag.id.substringAfterLast("-")
        }
        record("burst", "dispatcher-$identity", "queued",
          """{"dispatcher":$identity,"queued":${if (count > 128) count else queued.size},"running":${dispatcher.runningCallsCount()},"queueMissing":$missing,"queueTruncated":${count > 128 || queued.size > 128},"queueCodes":"$codes"}""")
        return
      }
      previous = peak.get()
    }
  }

  fun endpoint(request: Request): String = when (val path = request.url.encodedPath) {
    "/api/auth/me", "/api/members", "/api/me/preferences", "/api/summary", "/api/alerts" -> path
    else -> when {
      path.startsWith("/api/members/") && path.endsWith("/battery") -> "/api/members/:id/battery"
      path.startsWith("/api/members/") && path.endsWith("/location") -> "/api/members/:id/location"
      path.startsWith("/api/billing/") -> "/api/billing/:route"
      path.startsWith("/api/check") -> "/api/check-in/:route"
      path.startsWith("/api/medication") -> "/api/medication/:route"
      else -> "/api/other"
    }
  }

  @JvmStatic fun record(kind: String, id: String, stage: String, detail: String) {
    if (kind !in setOf("request", "operation", "task", "burst") || stage !in stages
      || id.length !in 1..96 || detail.length > 2048) return
    val event = Event(kind, id, stage, detail, SystemClock.elapsedRealtime(), System.currentTimeMillis(), ordinal.incrementAndGet())
    if (!pending.offer(event)) dropped.incrementAndGet()
    schedule()
  }
  private fun schedule() {
    if (draining.compareAndSet(false, true) && !writer.post { drain() }) {
      draining.set(false); dropped.incrementAndGet()
    }
  }

  private fun drain() {
    var n = 0
    while (n++ < 64) {
      val event = pending.poll() ?: break
      try { consume(event) } catch (_: Exception) { failures++ }
    }
    if (pending.isNotEmpty()) {
      if (!writer.post { drain() }) { draining.set(false); dropped.incrementAndGet() }
    }
    else {
      draining.set(false)
      if (pending.isNotEmpty()) schedule()
    }
    if (!flushScheduled) {
      flushScheduled = true
      writer.postDelayed({ flushScheduled = false; flush() }, 1000)
    }
  }

  private fun consume(event: Event) {
    val table = when (event.kind) { "request" -> requests; "operation" -> operations; "burst" -> bursts; else -> tasks }
    val key = "$process:${event.id}"
    val row = table.getOrPut(key) { JSONObject().put("id", event.id).put("process", process) }
    val detail = JSONObject(event.detail)
    if (event.kind == "burst") {
      val codes = detail.optString("queueCodes")
      if (codes.length <= 1536 && Regex("[0-9 ]*").matches(codes)) row.put("queueCodes", codes)
    }
    val stage = JSONObject().put("elapsed", event.elapsed).put("wall", event.wall).put("sequence", event.sequence)
    for (name in fields) {
      val value = detail.opt(name)
      if (value is Number || value is Boolean || (value is String && value.length <= 96
          && Regex("[A-Za-z0-9_/:. -]*").matches(value))) {
        if (name in setOf("queued", "running", "dispatcher")) stage.put(name, value)
        else row.put(name, value)
      }
    }
    row.put(event.stage, stage)
    if (event.kind == "request") {
      val opaque = row.optString("request")
      if (opaque.length == 32 && event.stage in setOf("native_start", "ended", "failed", "canceled"))
        DeepAsyncTrace.recordAt("request", opaque,
          if (event.stage == "native_start") "native_http_associated" else "native_" + event.stage,
          "{}", event.elapsed, event.wall)
    }
    if (event.kind == "task" && event.stage == "removed") {
      val invoked = row.optJSONObject("invoked")
      if (invoked != null && row.optLong("timeoutMs") > 0) {
        row.put("deadlineReachedAtRemoval", event.elapsed - invoked.optLong("elapsed") >= row.optLong("timeoutMs"))
      }
    }
    if (event.kind == "task" && event.stage in setOf("queued", "invoked", "removed")) {
      val safe = JSONObject()
      for (field in listOf("taskId", "reactTaskId", "context", "timeoutMs", "deadlineReachedAtRemoval"))
        if (row.has(field)) safe.put(field, row.get(field))
      DeepAsyncTrace.recordAt("wake", row.optString("wake"),
        if (event.stage == "removed") "native_lifetime_removed" else "native_task_" + event.stage,
        safe.toString(), event.elapsed, event.wall)
    }
    // Bounded dimensions; cumulative counts remain useful after detail eviction.
    val counter = "${event.kind}:${row.optString("origin", "unknown")}:${row.optString("phase", "none")}:${event.stage}"
    if (counts.containsKey(counter) || counts.size < 256) counts[counter] = (counts[counter] ?: 0) + 1
    else counts["overflow"] = (counts["overflow"] ?: 0) + 1
    val capacity = when (event.kind) { "request" -> REQUEST_CAPACITY; "burst" -> 8; else -> OTHER_CAPACITY }
    while (table.size > capacity) { table.remove(table.keys.first()); evicted++ }
  }

  private fun snapshot(): JSONObject = JSONObject().put("available", true).put("version", 1)
    .put("publishedOrdinal", ordinal.get())
    .put("process", process).put("requests", JSONArray(requests.values.toList()))
    .put("operations", JSONArray(operations.values.toList())).put("tasks", JSONArray(tasks.values.toList()))
    .put("queueSnapshots", JSONArray(bursts.values.toList()))
    .put("counts", JSONObject(counts.toMap())).put("evictedRecords", evicted)
    .put("countsScope", "cumulative across retained process history, not queue occupancy")
    .put("queueDropped", priorDropped + dropped.get()).put("bindingDropped", priorBindingDropped + bindingDropped.get())
    .put("pendingBindings", bindings.size).put("pendingEvents", pending.size)
    .put("queueHighWater", pending.highWater.get()).put("workerFailures", writer.failures.get())
    .put("activeCallAssociations", calls.size)
    .put("observerFailures", failures).put("restoreFailures", restoreFailures)
    .put("limits", "512 requests; 256 operations; 256 tasks; 8 queue snapshots (128 IDs each); 2048 pending events; 512 pending bindings; 256 counter dimensions plus overflow; 2 MiB per file")
    .put("coverage", "Monotonic ordering only within process. Unknown origins and loss counters prevent complete attribution claims. Async buffered data may be lost on death; native removal is not JS cancellation.")

  private fun restore() {
    try {
      val target = file ?: return
      if (!target.exists()) return
      if (target.length() > MAX_FILE_BYTES) { restoreFailures++; return }
      val root = JSONObject(target.readText())
      for ((name, table, capacity) in listOf(Triple("requests", requests, REQUEST_CAPACITY),
        Triple("operations", operations, OTHER_CAPACITY), Triple("tasks", tasks, OTHER_CAPACITY),
        Triple("queueSnapshots", bursts, 8))) {
        val rows = root.optJSONArray(name) ?: continue
        for (i in maxOf(0, rows.length() - capacity) until rows.length()) {
          val row = rows.getJSONObject(i)
          table["${row.getString("process")}:${row.getString("id")}"] = row
        }
      }
      priorDropped = root.optLong("queueDropped")
      priorBindingDropped = root.optLong("bindingDropped")
      failures += root.optLong("observerFailures")
      restoreFailures += root.optLong("restoreFailures")
      evicted = root.optLong("evictedRecords")
      val oldCounts = root.optJSONObject("counts")
      oldCounts?.keys()?.asSequence()?.take(257)?.forEach { counts[it] = oldCounts.optLong(it) }
    } catch (_: Exception) { restoreFailures++ }
  }

  private fun flush() {
    try {
      val target = file ?: return
      val data = snapshot().toString()
      check(data.toByteArray().size <= MAX_FILE_BYTES)
      val temporary = File(target.path + ".tmp")
      temporary.writeText(data)
      check(temporary.renameTo(target))
    } catch (_: Exception) { failures++ }
    finally { cachedSnapshot = snapshot().toString() }
  }

  @JvmStatic fun read(): String = cachedSnapshot
}
