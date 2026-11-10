import android.app.Application
import android.app.Activity
import android.content.Context
import android.os.SystemClock
import com.facebook.react.runtime.SchedulingProbe
import expo.modules.startupdiagnostics.DeepAsyncTrace
import expo.modules.startupdiagnostics.SchedulingBridge
import expo.modules.startupdiagnostics.SchedulingTrace
import expo.modules.startupdiagnostics.RecorderWorker
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject

object IntegrationDriver {
  @JvmStatic external fun runtime(id: Long)
  @JvmStatic external fun selected(handle: Long)
  @JvmStatic external fun timer(stage: Int, handle: Long)
  @JvmStatic external fun advance(nanos: Long)
  @JvmStatic external fun firstExecutor()
  @JvmStatic external fun exhaust()
}

private var checks = 0
private fun verify(value: Boolean, message: String) { check(value) { message }; checks++ }
private fun await(message: String, predicate: () -> Boolean) {
  val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
  while (!predicate()) { check(System.nanoTime() < until) { message }; Thread.sleep(10) }
}
private fun snapshot() = JSONObject(SchedulingTrace.read())
private fun id(value: Int) = "%032x".format(value)
private val root = id(1)
private val flight = id(2)
private val js = id(3)
/** Test-only: enqueue the compiler's actual production tick body on its worker. */
private fun tickNow() {
  val field = DeepAsyncTrace::class.java.getDeclaredField("writer").apply { isAccessible = true }
  val worker = field.get(null) as RecorderWorker
  val body = DeepAsyncTrace::class.java.declaredMethods.single {
    it.name.startsWith("tick\$lambda") && it.parameterCount == 0
  }.apply { isAccessible = true }
  check(worker.post { body.invoke(null) })
}
private fun register(request: String, handle: Long, kind: Int): Long {
  IntegrationDriver.runtime(7)
  val registration = SchedulingBridge.begin(request, root, flight, js, kind or 256)
  IntegrationDriver.selected(handle)
  SchedulingProbe.event(10, 11, handle, if (kind == 2) 8000 else 0, 0)
  SchedulingProbe.event(11, 11, handle, SystemClock.elapsedRealtime(), 2)
  SchedulingBridge.end(registration, handle)
  return registration
}
private fun complete(registration: Long, handle: Long) {
  SchedulingProbe.event(14, 11, handle, System.nanoTime(), 0)
  IntegrationDriver.timer(15, handle)
  IntegrationDriver.timer(16, handle)
  SchedulingBridge.callback(registration)
}

fun main(args: Array<String>) {
  val directory = File(args[0]).apply { mkdirs() }
  val application = Application(directory)
  if (args[1] == "exhaustion") {
    SchedulingTrace.install(application)
    System.load(args[2])
    SchedulingProbe.prepare()
    DeepAsyncTrace.install(application)
    DeepAsyncTrace.startWorker()
    IntegrationDriver.exhaust()
    tickNow()
    val file = File(directory, "scheduling-evidence-78.json")
    await("context exhaustion reached actual disk/export") {
      file.isFile && JSONObject(file.readText()).optJSONObject("native")?.optBoolean("contextClosed") == true
    }
    val native = JSONObject(file.readText()).getJSONObject("native")
    verify(native.getLong("contextExhaustions") == 1L, "capacity failure explicitly counted")
    verify(native.getLong("contextLoss") > 0, "unknown coverage explicitly counted")
    verify(native.getInt("contextCapacity") == 64, "bounded capacity exported")
    println("PASS $checks context-exhaustion persistence assertions")
    return
  }
  if (args[1] == "disabled") {
    DeepAsyncTrace.install(application)
    DeepAsyncTrace.startWorker()
    await("ordinary deep worker ready") { JSONObject(DeepAsyncTrace.read()).has("queueDepth") }
    tickNow()
    verify(SchedulingTrace.read().contains("\"disabled\""), "production scheduling capture disabled")
    verify(!File(directory, "scheduling-evidence-78.json").exists(), "no production scheduling persistence")
    verify(!SchedulingBridge.available(), "no production JNI activation")
    println("PASS $checks non-diagnostic isolation assertions")
    return
  }
  if (args[1] == "restore") {
    SchedulingTrace.install(application)
    DeepAsyncTrace.install(application)
    DeepAsyncTrace.startWorker()
    await("restored snapshot") { snapshot().optJSONArray("incidents")?.length() == 1 }
    val capsule = snapshot().getJSONArray("incidents").getJSONObject(0)
    verify(capsule.getJSONArray("timers").length() == 6, "six restored timers")
    val timer = capsule.getJSONArray("timers").getJSONObject(0)
    verify(timer.getBoolean("priorProcessRecord"), "old process not rebound")
    verify(timer.has("stage17") && timer.has("stage16"), "callback/executor persisted")
    verify(!SchedulingBridge.available(), "old evidence readable without native activation")
    println("PASS $checks fresh-JVM restore assertions")
    return
  }

  verify(SchedulingBridge.begin(root, root, flight, js, 1) == 0L, "cold disabled producer")
  SchedulingProbe.event(6, 11, 0, 0, 32) // genuinely first class use, library absent
  verify(Thread.getAllStackTraces().keys.none { it.name.startsWith("kinnship-") }, "no cold worker startup")
  SchedulingTrace.install(application) // production lifecycle/class prewarm
  verify(application.callbacks != null, "Activity lifecycle wired")
  application.callbacks.onActivityResumed(Activity())

  System.load(args[2]) // independent lifecycle, NOT a producer fallback
  IntegrationDriver.firstExecutor() // C++ observation before ready; must return
  SchedulingProbe.prepare() // actual reflection/activate/JNI linkage warmup
  verify(SchedulingBridge.available(), "real JNI bridge activated")
  IntegrationDriver.runtime(7)
  SchedulingProbe.event(3, 11, 7, 0, 1)
  SchedulingProbe.event(4, 7, 7, 0, 1)
  SchedulingBridge.progress(6)

  Context.filesGate = CountDownLatch(1)
  Context.filesEntered = CountDownLatch(1)
  DeepAsyncTrace.install(application)
  DeepAsyncTrace.startWorker()
  verify(Context.filesEntered.await(5, TimeUnit.SECONDS), "storage gate entered on existing worker")
  val producer = Executors.newSingleThreadExecutor()
  val pending = producer.submit<List<Pair<Long, Long>>> {
    (0..2).flatMap { helper ->
      val request = id(100 + helper)
      DeepAsyncTrace.record("request", request, "helper_entered", """{"operation":"$root","flight":"$flight"}""")
      DeepAsyncTrace.bind(application, 100 + helper, request)
      DeepAsyncTrace.record("request", request, "fetch_callback_scheduled", "{}")
      (1..2).map { kind ->
        val handle = 20L + helper * 2 + kind
        register(request, handle, kind) to handle
      }
    }
  }.get(5, TimeUnit.SECONDS)
  verify(pending.size == 6 && Context.filesGate.count == 1L, "first real producers finish before disk readiness")
  producer.shutdown()
  Context.filesGate.countDown(); Context.filesGate = null
  DeepAsyncTrace.record("operation", root, "flight_created", """{"operation":"$root","flight":"$flight","origin":"workmanager"}""")
  DeepAsyncTrace.record("flight", flight, "flight_created", """{"operation":"$root"}""")
  DeepAsyncTrace.record("operation", id(4), "consumer_attached", """{"operation":"${id(4)}","flight":"$flight","origin":"workmanager"}""")
  await("initial drain") { snapshot().optJSONArray("timers")?.length() == 6 }
  val initial = snapshot().getJSONArray("timers").getJSONObject(0)
  verify(listOf(8, 9, 10, 11).all { initial.has("stage$it") }, "actual registration markers joined")
  verify(initial.getJSONObject("creation").getString("js") == js, "runtime identity")
  verify(initial.getJSONArray("beforeGap").toString().contains("\"stage\":2"), "Activity pre-gap state")
  verify(initial.getJSONArray("beforeGap").toString().contains("\"stage\":3"), "RN instance pre-gap state")
  verify(initial.getJSONArray("beforeGap").toString().contains("\"stage\":4"), "native runtime pre-gap state")
  verify(initial.getJSONArray("beforeGap").toString().contains("\"stage\":5"), "JS runtime binding state")
  verify(snapshot().getJSONObject("native").getJSONArray("counters").length() > 0, "natural progress counters exported")
  await("deep request snapshot after native drain") { DeepAsyncTrace.read().contains("fetch_callback_scheduled") }
  verify(JSONObject(DeepAsyncTrace.read()).toString().contains("fetch_callback_scheduled"), "old intent intact")

  val stallMs = 46L * 60 * 1000
  SystemClock.offset = stallMs; IntegrationDriver.advance(stallMs * 1000000)
  tickNow()
  val savedFile = File(directory, "scheduling-evidence-78.json")
  await("46-minute capsule persisted") { savedFile.exists() && JSONObject(savedFile.readText()).getJSONArray("incidents").length() == 1 }
  verify(snapshot().getJSONArray("incidents").getJSONObject(0).getJSONArray("timers").length() == 6, "six old witnesses pinned")
  verify(snapshot().getJSONArray("incidents").getJSONObject(0).getBoolean("followerRetained"), "follower projection retained")
  IntegrationDriver.runtime(0) // prove host cause survives between independent JNI calls
  SchedulingProbe.event(6, 11, -1, 0, 32)
  SchedulingProbe.event(7, 11, -1, 0, 1)
  SchedulingProbe.event(6, 11, -1, 0, 160)
  SchedulingProbe.event(7, 11, -1, 0, 2) // outside host scope must not inherit it
  SchedulingProbe.event(13, 11, -1, SystemClock.elapsedRealtime(), 1)
  IntegrationDriver.runtime(7)
  for ((registration, handle) in pending) complete(registration, handle)
  tickNow()
  await("late callbacks persisted") {
    savedFile.exists() && JSONObject(savedFile.readText()).getJSONArray("incidents").getJSONObject(0)
      .getJSONArray("timers").getJSONObject(0).has("stage17")
  }
  for (i in 0 until 3000) {
    val registration = register(id(1000 + i), 1000L + i, 1)
    complete(registration, 1000L + i)
    DeepAsyncTrace.record("operation", id(1000 + i), "consumer_attached", """{"origin":"foreground"}""")
  }
  tickNow()
  await("foreground flood captured") { snapshot().getJSONArray("timers").length() <= 128 }
  val capsule = snapshot().getJSONArray("incidents").getJSONObject(0)
  val timers = capsule.getJSONArray("timers")
  verify(timers.length() == 6, "flood cannot evict pinned witnesses")
  for (i in 0 until 6) {
    val row = timers.getJSONObject(i)
    verify(listOf(8, 9, 10, 11, 14, 15, 16, 17).all { row.has("stage$it") }, "complete chain $i")
    verify(row.getJSONObject("stage17").getLong("elapsedNs") - row.getJSONObject("creation").getLong("elapsedNs") >= stallMs * 1000000, "elapsed 46-minute interval $i")
  }
  verify(capsule.getJSONArray("release").toString().contains("\"stage\":7"), "release state persisted")
  verify(capsule.getJSONArray("release").toString().contains("\"stage\":13"), "native frame marker exported")
  val release = capsule.getJSONArray("release")
  val releaseRows = (0 until release.length()).map { release.getJSONObject(it) }
  val host = releaseRows.first { it.optInt("stage") == 6 && it.optInt("state") == 32 }
  val frame = releaseRows.first { it.optInt("stage") == 7 && it.optInt("state") == 1 }
  val outside = releaseRows.first { it.optInt("stage") == 7 && it.optInt("state") == 2 }
  verify(host.getLong("value") != 0L && host.getLong("value") == frame.getLong("value"), "cross-JNI host/frame cause preserved")
  verify(outside.getLong("value") == 0L, "host cause cannot leak across recycled ownership")
  verify(snapshot().getJSONArray("timers").length() <= 128, "bounded ordinary rows")
  tickNow()
  await("final persisted snapshot") { savedFile.length() > 0 && JSONObject(savedFile.readText()).toString().contains("\"stage17\"") }
  verify(savedFile.length() <= 512 * 1024, "bounded production snapshot for flood")
  // Make the actual .tmp write fail, not a replacement storage implementation.
  val blocker = File(directory, "scheduling-evidence-78.json.tmp")
  blocker.delete(); blocker.mkdir()
  tickNow()
  await("write failure observed") {
    tickNow()
    snapshot().optLong("captureFailures") > 0
  }
  verify(JSONObject(savedFile.readText()).getJSONArray("incidents").length() == 1, "failed write preserves previous file")
  blocker.delete()
  tickNow()
  await("successful rewrite after storage failure") {
    savedFile.isFile && JSONObject(savedFile.readText()).optLong("captureFailures") > 0
  }
  verify(JSONObject(savedFile.readText()).optLong("captureFailures") > 0, "recovery actually reached disk")
  println("PASS $checks real JNI -> production queue/worker -> disk -> export assertions")
  println("LIMIT: JVM Android lifecycle/clock adapters and simulated time, not physical Android scheduling")
}
