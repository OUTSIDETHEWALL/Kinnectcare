package expo.modules.startupdiagnostics

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import com.facebook.react.bridge.ReadableMap
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** No observer lock, disk access or JSON parsing on a production call path. */
object DeepAsyncTrace {
  private const val CAPACITY = 512
  private const val QUEUE = 2048
  private val process = UUID.randomUUID().toString().replace("-", "")
  private data class Event(val kind: String, val id: String, val stage: String, val detail: String,
    val elapsed: Long, val wall: Long)
  private val events = ConcurrentLinkedQueue<Event>()
  private val depth = AtomicInteger()
  private val draining = AtomicBoolean()
  private val drops = AtomicLong()
  private val bindingDrops = AtomicLong()
  private val installed = AtomicBoolean()
  private val numeric = ConcurrentHashMap<String, String>()
  private val bodies = ConcurrentHashMap<String, String>()
  private val promises = ConcurrentHashMap<Any, String>()
  private val thread by lazy { HandlerThread("kinnship-deep-async", android.os.Process.THREAD_PRIORITY_BACKGROUND).apply { start() } }
  private val writer by lazy { Handler(thread.looper) }
  // Writer-only state. read() returns a precomputed immutable snapshot.
  private val entities = linkedMapOf<String, JSONObject>()
  private val wakes = linkedMapOf<String, JSONObject>()
  private var evicted = 0L
  private var failures = 0L
  private var restoreFailures = 0L
  private var file: File? = null
  private var refreshScheduled = false
  private var dirty = false
  @Volatile private var snapshot = """{"available":true,"version":1,"entities":[]}"""
  private val ids = Regex("[a-f0-9]{32}")
  private val stages = Regex("[a-z][a-z0-9_]{0,71}")
  private val fields = setOf("operation", "origin", "phase", "wake", "generation", "request", "flight",
    "endpoint", "count", "reason", "eligible", "runtime", "context", "taskId", "reactTaskId",
    "timeoutMs", "deadlineReachedAtRemoval")

  @JvmStatic fun install(context: Context) {
    try {
      if (!installed.compareAndSet(false, true)) return
      val application = context.applicationContext
      writer.post {
        file = File(application.filesDir, "deep-async-v1.json")
        try {
          val f = file!!
          if (f.exists() && f.length() <= 4 * 1024 * 1024) {
            val saved = JSONObject(f.readText()).optJSONArray("entities") ?: JSONArray()
            for (i in 0 until minOf(saved.length(), CAPACITY)) {
              val row = saved.getJSONObject(i)
              entities[row.getString("kind") + ":" + row.getString("id")] = row
            }
          }
        } catch (_: Throwable) { restoreFailures++ }
        refresh()
        tick()
      }
    } catch (_: Throwable) { drops.incrementAndGet() }
  }

  @JvmStatic fun record(kind: String, id: String, stage: String, detail: String) {
    recordAt(kind, id, stage, detail, SystemClock.elapsedRealtime(), System.currentTimeMillis())
  }
  @JvmStatic fun recordAt(kind: String, id: String, stage: String, detail: String, elapsed: Long, wall: Long) {
    try {
      if (kind !in setOf("request", "operation", "flight", "wake") || !ids.matches(id)
        || !stages.matches(stage) || detail.length > 1024) return
      if (depth.incrementAndGet() > QUEUE) { depth.decrementAndGet(); drops.incrementAndGet(); return }
      events.offer(Event(kind, id, stage, detail, elapsed, wall))
      schedule()
    } catch (_: Throwable) { drops.incrementAndGet() }
  }
  private fun schedule() {
    if (draining.compareAndSet(false, true)) {
      try { writer.post { drain() } } catch (_: Throwable) { draining.set(false); drops.incrementAndGet() }
    }
  }
  private fun drain() {
    try {
      var event = events.poll()
      while (event != null) {
        depth.decrementAndGet()
        try { accept(event) } catch (_: Throwable) { failures++ }
        event = events.poll()
      }
      if (!refreshScheduled) {
        refreshScheduled = true
        writer.postDelayed({ refreshScheduled = false; refresh() }, 1000)
      }
    } finally {
      draining.set(false)
      if (events.isNotEmpty()) schedule()
    }
  }
  private fun accept(e: Event) {
    dirty = true
    if (e.kind == "wake") {
      val info = JSONObject(e.detail).put("stage", e.stage).put("elapsed", e.elapsed).put("wall", e.wall)
      wakes[e.id] = info
      while (wakes.size > 128) wakes.remove(wakes.keys.first())
      entities.values.filter { it.optString("wake") == e.id }.forEach {
        it.put("nativeTask", info)
        if (e.stage == "native_lifetime_removed" && info.optBoolean("deadlineReachedAtRemoval")
          && !it.optBoolean("settled")) it.put("consumerExpiredBeforeResume", true)
      }
      return
    }
    val key = e.kind + ":" + e.id
    val row = entities[key] ?: JSONObject().put("kind", e.kind).put("id", e.id)
      .put("process", process).put("startedElapsed", e.elapsed).put("startedWall", e.wall)
      .put("history", JSONArray()).also { entities[key] = it }
    val detail = JSONObject(e.detail)
    for (field in fields) if (detail.has(field)) {
      val value = detail.get(field)
      if (value is Boolean || value is Number || (value is String && value.length <= 80
          && Regex("[a-zA-Z0-9_:\\-/.]{0,80}").matches(value))) row.put(field, value)
    }
    wakes[row.optString("wake")]?.let { row.put("nativeTask", it) }
    val history = row.getJSONArray("history")
    val stage = JSONObject().put("stage", e.stage).put("elapsed", e.elapsed).put("wall", e.wall)
    // Preserve creation and a bounded tail, including the latest pending stage.
    if (history.length() >= 32) history.remove(1)
    history.put(stage)
    if (e.stage.endsWith("_failed") || e.stage.endsWith("_rejected")) row.put("failureBoundary", row.opt("last"))
    if (e.elapsed >= (row.optJSONObject("last")?.optLong("elapsed", 0L) ?: 0L)) row.put("last", stage)
    if (e.stage.endsWith("_fulfilled") || e.stage.endsWith("_completed") || e.stage.endsWith("_returned")
      || e.stage.endsWith("_received") || e.stage.endsWith("_resumed")) {
      if (e.elapsed >= (row.optJSONObject("lastCompleted")?.optLong("elapsed") ?: 0L)) row.put("lastCompleted", stage)
    }
    if (e.stage.endsWith("_entered")) row.put("settled", false)
    if (e.stage in setOf("helper_exited", "ownership_returned", "contact_returned", "headless_log_completed", "battery_publication_returned")
      || (e.kind == "flight" && e.stage in setOf("aggregate_fulfilled", "aggregate_rejected"))) row.put("settled", true)
    row.put("ageMs", if (row.optString("process") == process) e.elapsed - row.getLong("startedElapsed")
      else maxOf(0, e.wall - row.getLong("startedWall")))
    if (row.optLong("ageMs") >= 120000) row.put("everPathological", true)
    if (entities.size > CAPACITY) {
      val protected = protectedIds()
      val victim = entities.entries.firstOrNull { it.key !in protected }?.key ?: entities.keys.last()
      entities.remove(victim); evicted++
    }
  }
  private fun protectedIds(): Set<String> {
    val keep = mutableSetOf<String>()
    // Preserve the failure AFTER late foreground resumption, not just while pending.
    for (wm in listOf(false, true)) {
      for (historical in listOf(false, true)) {
        val root = entities.entries.firstOrNull { it.value.optString("kind") == "operation"
          && it.value.optString("origin") != "headless-entry"
          && (if (historical) it.value.optBoolean("everPathological") else !it.value.optBoolean("settled"))
          && (it.value.optString("origin") == "workmanager") == wm }
        if (root != null) {
        keep.add(root.key)
        val op = root.value.optString("id")
        val children = entities.entries.filter { it.value.optString("operation") == op }
        children.forEach { keep.add(it.key) }
        val flight = root.value.optString("flight")
        if (flight.isNotEmpty()) {
          keep.add("flight:$flight")
          entities.entries.firstOrNull { it.value.optString("kind") == "operation"
            && it.value.optString("flight") == flight && it.key != root.key }?.let { follower ->
            keep.add(follower.key)
            entities.entries.filter { it.value.optString("operation") == follower.value.optString("id") }
              .forEach { keep.add(it.key) }
          }
        }
      }
      }
    }
    return keep
  }
  private fun refresh() {
    val now = SystemClock.elapsedRealtime()
    entities.values.forEach { row ->
      val age = if (row.optString("process") == process) now - row.optLong("startedElapsed")
        else maxOf(0, System.currentTimeMillis() - row.optLong("startedWall"))
      row.put("pathological", !row.optBoolean("settled") && age >= 120000)
      if (!row.optBoolean("settled") && age >= 120000) row.put("everPathological", true)
    }
    snapshot = JSONObject().put("available", true).put("version", 1).put("process", process)
      .put("capacity", CAPACITY).put("entities", JSONArray(entities.values.toList()))
      .put("queueDepth", depth.get()).put("observerDrops", drops.get()).put("bindingDrops", bindingDrops.get())
      .put("evicted", evicted).put("writeFailures", failures).put("restoreFailures", restoreFailures).toString()
  }
  private fun tick() {
    writer.postDelayed({
      try {
        refresh()
        val f = file
        if (f != null && dirty) {
          val tmp = File(f.path + ".tmp"); tmp.writeText(snapshot)
          if (!tmp.renameTo(f)) { failures++; tmp.delete() }
          else dirty = false
        }
      } catch (_: Throwable) { failures++ }
      tick()
    }, 60000)
  }
  @JvmStatic fun read(): String = snapshot
  @JvmStatic fun bind(context: Context, request: Int, opaque: String) {
    try {
      if (!ids.matches(opaque)) return
      install(context)
      val key = System.identityHashCode(context).toString() + ":" + request
      if (numeric.size >= 2048 && !numeric.containsKey(key)) {
        // Bounded, nonblocking turnover. Lost correlations are counted, never guessed.
        numeric.keys.iterator().let { if (it.hasNext()) { numeric.remove(it.next()); bindingDrops.incrementAndGet() } }
      }
      numeric[key] = opaque
      record("request", opaque, "native_request_bound", """{"context":${System.identityHashCode(context)}}""")
    } catch (_: Throwable) { drops.incrementAndGet() }
  }
  @JvmStatic fun nativeEmission(context: Any?, request: Int, stage: String) {
    try {
      val id = numeric[System.identityHashCode(context).toString() + ":" + request] ?: return
      record("request", id, stage, "{}")
    } catch (_: Throwable) { drops.incrementAndGet() }
  }
  @JvmStatic fun bodyBind(blob: String, request: String) {
    try {
      if (ids.matches(request) && blob.length <= 100 && bodies.size < 512) bodies[blob] = request
      else bindingDrops.incrementAndGet()
    } catch (_: Throwable) { drops.incrementAndGet() }
  }
  @JvmStatic fun nativeBody(data: Any?, promise: Any?) {
    try {
      val blob = (data as? ReadableMap)?.getString("blobId") ?: return
      val id = bodies.remove(blob) ?: return
      if (promise != null && promises.size < 512) promises[promise] = id else bindingDrops.incrementAndGet()
      record("request", id, "native_body_read_entered", "{}")
    } catch (_: Throwable) { drops.incrementAndGet() }
  }
  @JvmStatic fun promiseAttempt(promise: Any?, stage: String) {
    try { val id = promises.remove(promise) ?: return; record("request", id, stage, "{}") }
    catch (_: Throwable) { drops.incrementAndGet() }
  }
}
