package expo.modules.startupdiagnostics

import android.app.Activity
import android.app.Application
import android.app.ActivityManager
import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Producers capture primitives only. capture() is called ONLY by the existing deep worker. */
object SchedulingTrace {
  private data class Lifecycle(val stage: Int, val id: Int, val state: Int, val elapsed: Long, val uptime: Long)
  private val events = RecorderQueue<Lifecycle>(128)
  private val losses = AtomicLong()
  @Volatile private var enabled = false
  private val process = UUID(System.currentTimeMillis(), System.nanoTime()).toString().replace("-", "")
  @Volatile private var snapshot = """{"available":false,"schema":78,"reason":"not_captured"}"""
  private var context: Context? = null // initialized and consumed on the deep worker
  private var path: File? = null
  private val store = SchedulingRetention()
  private val names = listOf("process_observed", "activity_state", "rn_instance_state", "runtime_state",
    "js_runtime_bound", "timer_host_state", "timer_frame_control", "timer_schedule_enter",
    "timer_schedule_return", "native_timer_create_enter", "native_timer_admitted", "native_timer_deleted",
    "timer_frame_observed", "timer_dispatch_attempt", "cpp_timer_submit", "cpp_timer_runtime_enter",
    "timer_callback_enter", "natural_runtime_progress", "natural_js_progress", "scheduler_context_sample",
    "incident_capture_status")

  /** Explicit Application initialization only; never called by a producer. */
  @JvmStatic fun install(application: Application) {
    enabled = true // only the diagnostic >=78 MainApplication mod emits this call
    // Independent Application lifecycle prewarms class initialization before
    // vendor callbacks. No native symbol call/load or recorder startup here.
    try { Class.forName("com.facebook.react.runtime.SchedulingProbe") } catch (_: Throwable) {}
    SchedulingBridge.available()
    // No worker, timer, disk, network, JS or process-eligibility request here.
    application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityCreated(a: Activity, b: Bundle?) = observe(2, a, if (b == null) 1 else 2)
      override fun onActivityStarted(a: Activity) = observe(2, a, 3)
      override fun onActivityResumed(a: Activity) = observe(2, a, 4)
      override fun onActivityPaused(a: Activity) = observe(2, a, 5)
      override fun onActivityStopped(a: Activity) = observe(2, a, 6)
      override fun onActivityDestroyed(a: Activity) = observe(2, a, 7)
      override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
    })
  }
  private fun observe(stage: Int, activity: Activity, state: Int) {
    try {
      if (!events.offer(Lifecycle(stage, System.identityHashCode(activity), state,
          SystemClock.elapsedRealtime() * 1000000, System.nanoTime()))) losses.incrementAndGet()
    } catch (_: Throwable) { losses.incrementAndGet() }
  }
  /** Existing deep-worker initialization; all restore/serialization is off-path. */
  fun initialize(application: Context) {
    context = application.applicationContext
    if (!enabled) return
    path = File(application.filesDir, "scheduling-evidence-78.json")
    try {
      val f = path!!
      if (f.exists() && f.length() <= 512 * 1024) store.restore(JSONObject(f.readText()))
    } catch (_: Throwable) { store.restoreFailures++ }
    store.accept(JSONObject().put("stage", 1).put("process", process)
      .put("elapsedNs", SystemClock.elapsedRealtime() * 1000000)
      .put("wallMs", System.currentTimeMillis())
      .put("state", "application_observed_not_exact_process_birth"))
  }
  fun capture(persist: Boolean, correlations: Collection<JSONObject> = emptyList()) {
    if (!enabled) return
    try {
      if (path == null) context?.let { initialize(it) } // worker/app-start race
      val now = SystemClock.elapsedRealtime() * 1000000
      var event = events.poll()
      while (event != null) {
        store.accept(JSONObject().put("stage", event.stage).put("manager", event.id)
          .put("state", event.state).put("elapsedNs", event.elapsed).put("uptimeNs", event.uptime)
          .put("process", process))
        event = events.poll()
      }
      var native = JSONObject().put("ready", false)
      if (SchedulingBridge.available()) {
        try {
          native = JSONObject(SchedulingBridge.drainNative())
          val rows = native.optJSONArray("events") ?: JSONArray()
          for (i in 0 until rows.length()) store.accept(rows.getJSONObject(i).put("process", process))
          store.summary(process, now, native.optJSONArray("counters") ?: JSONArray())
        } catch (_: Throwable) { store.nativeReadFailures++ }
      }
      // Sparse samples from existing worker opportunities, not a new polling job.
      try {
        val state = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(state)
        store.accept(JSONObject().put("stage", 20).put("state", state.importance)
          .put("elapsedNs", SystemClock.elapsedRealtime() * 1000000)
          .put("wallMs", System.currentTimeMillis()).put("process", process))
      } catch (_: Throwable) { /* unavailable is not inferred foreground/background */ }
      var result = store.export(now, process)
      store.correlate(correlations)
      result.put("process", process).put("schema", 78)
        .put("available", true).put("native", native).put("lifecycleDrops", losses.get())
        .put("markerNamesOneBased", JSONArray(names))
        .put("legacyFetchScheduledMeaning", "intent_before_real_setTimeout")
        .put("compiledInclusion", "requires_delivered_artifact_verification")
        .put("nativeReady", SchedulingBridge.available())
        .put("interpretation", "silence_is_not_proof_of_suspension")
      // Drain events already joined into retention; do not duplicate raw ingress.
      native.remove("events")
      var serialized = result.toString()
      if (serialized.toByteArray(Charsets.UTF_8).size > 512 * 1024) {
        store.compact()
        val reduced = store.export(now, process)
        for (field in listOf("timers", "incidents", "bins", "overflow")) result.put(field, reduced.get(field))
        serialized = result.toString()
      }
      if (serialized.toByteArray(Charsets.UTF_8).size > 512 * 1024) {
        store.dropSummaryBins()
        result.put("bins", JSONArray()).put("summaryBinsOmittedForCriticalEvidence", true)
        serialized = result.toString()
      }
      if (serialized.toByteArray(Charsets.UTF_8).size > 512 * 1024) {
        // Prefer the OLDEST pathological capsule over replacing all evidence
        // with an unavailable sentinel. Full in-memory bounded state is retained.
        store.exportOverflows++
        val capsules = result.getJSONArray("incidents")
        val first = JSONArray()
        if (capsules.length() > 0) first.put(capsules.getJSONObject(0))
        result = JSONObject().put("schema", 78).put("process", process).put("available", true)
          .put("incidents", first).put("truncated", true).put("exportOverflows", store.exportOverflows)
          .put("reason", "oldest_pathological_capsule_priority").put("native", native)
        serialized = result.toString()
      }
      snapshot = serialized
      if (persist) {
        val f = path ?: return
        val tmp = File(f.path + ".tmp"); tmp.writeText(snapshot)
        if (!tmp.renameTo(f)) { store.writeFailures++; tmp.delete() }
      }
    } catch (_: Throwable) { store.captureFailures++ }
  }
  @JvmStatic fun read(): String =
    if (enabled) snapshot else """{"available":false,"schema":78,"reason":"disabled"}"""
}
