package expo.modules.startupdiagnostics

import android.content.Context
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

private fun waitFor(check: () -> Boolean) {
  val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
  while (!check()) { check(System.nanoTime() < until) { "recorder condition timed out" }; Thread.sleep(5) }
}
private fun field(name: String): Any =
  DeepAsyncTrace::class.java.getDeclaredField(name).apply { isAccessible = true }.get(null)
private fun event(n: Int) = DeepAsyncTrace.record("request", n.toString(16).padStart(32, '0'), "helper_entered", "{}")
private fun producers(threads: Int, count: Int, onStart: (() -> Unit)? = null): Long {
  val worst = AtomicLong()
  val go = CountDownLatch(1)
  val done = CountDownLatch(threads)
  repeat(threads) { thread ->
    Thread {
      go.await()
      repeat(count) {
        val start = System.nanoTime()
        event(100 + thread * count + it)
        val latency = System.nanoTime() - start
        worst.accumulateAndGet(latency, ::maxOf)
      }
      done.countDown()
    }.start()
  }
  go.countDown()
  onStart?.invoke()
  check(done.await(8, TimeUnit.SECONDS)) { "producers waited for diagnostic infrastructure" }
  return worst.get()
}
fun main(args: Array<String>) {
  val mode = args[1]
  val context = Context(File(args[0]).apply { mkdirs() })
  if (mode == "shared" || mode == "storage") {
    val entered = CountDownLatch(1)
    Context.filesEntered = entered
    if (mode == "storage") Context.failFiles = true
    val done = CountDownLatch(8)
    repeat(8) { thread ->
      Thread {
        repeat(2000) {
          event(thread * 2000 + it)
          RequestOrigins.record("operation", "cold-$thread-$it", "created", "{}")
          EvidenceTrace.record(context, "http", "native_call_start", "a".repeat(32), "{}")
        }
        done.countDown()
      }.start()
    }
    check(done.await(8, TimeUnit.SECONDS))
    check(entered.count == 1L) { "a producer accessed files" }
    DeepAsyncTrace.install(context); RequestOrigins.install(context)
    DeepAsyncTrace.startWorker(); RequestOrigins.startWorker(); EvidenceTrace.startWorker()
    waitFor { JSONObject(EvidenceTrace.read(context)).optBoolean("available")
      && JSONObject(RequestOrigins.read()).optBoolean("available")
      && JSONObject(DeepAsyncTrace.read()).getJSONArray("entities").length() > 0 }
    if (mode == "storage") {
      check(JSONObject(DeepAsyncTrace.read()).getLong("restoreFailures") > 0)
      check(JSONObject(RequestOrigins.read()).getLong("restoreFailures") > 0)
      check(JSONObject(EvidenceTrace.read(context)).getLong("readFailures") > 0)
    }
    println("PASS $mode: all three actual recorder producer paths finish before worker startup/filesystem access")
    return
  }
  // Deliberately first-touch the real singleton from multiple producers.
  if (mode == "concurrent") {
    val worst = producers(8, 2000)
    val worker = field("writer") as RecorderWorker
    check(worker.starts.get() == 0) { "recording started infrastructure" }
    DeepAsyncTrace.install(context); DeepAsyncTrace.startWorker()
    waitFor { JSONObject(DeepAsyncTrace.read()).getJSONArray("entities").length() > 0 }
    check(worker.starts.get() == 1)
    println("PASS concurrent cold initialization: no readiness waits; one lifecycle-created worker; worstNs=$worst")
    return
  }
  if (mode == "cold") {
    event(1)
    val worker = field("writer") as RecorderWorker
    check(worker.starts.get() == 0)
    check(Context.filesEntered == null)
    DeepAsyncTrace.install(context); DeepAsyncTrace.startWorker()
    waitFor { JSONObject(DeepAsyncTrace.read()).getJSONArray("entities").length() == 1 }
    println("PASS cold first actual event returns before any recorder thread exists; event survives independent bootstrap")
    return
  }
  val worker = field("writer") as RecorderWorker
  if (mode == "delayed") {
    val entered = CountDownLatch(1); val gate = CountDownLatch(1)
    Context.filesEntered = entered; Context.filesGate = gate
    DeepAsyncTrace.install(context); DeepAsyncTrace.startWorker()
    check(entered.await(2, TimeUnit.SECONDS))
    val worst = producers(8, 2000)
    check(gate.count == 1L) // Infrastructure is STILL initializing after producers finish.
    gate.countDown(); Context.filesGate = null
    waitFor { JSONObject(DeepAsyncTrace.read()).getJSONArray("entities").length() > 0 }
    println("PASS delayed initialization/storage readiness: producer completion precedes gate release; worstNs=$worst")
    return
  }
  if (mode == "failure" || mode == "shutdown") {
    worker.post { throw IllegalStateException("simulated consumer failure") }
    worker.start()
    waitFor { worker.failures.get() == 1L }
    val entered = CountDownLatch(1); val gate = CountDownLatch(1)
    worker.post { entered.countDown(); gate.await() }
    check(entered.await(2, TimeUnit.SECONDS))
    val lifecycleDone = CountDownLatch(1)
    val worst = if (mode == "shutdown") producers(8, 2000) {
      Thread {
        repeat(100) {
          worker.shutdown()
          check(!worker.start()) { "recreation overlapped blocked old worker" }
        }
        lifecycleDone.countDown()
      }.start()
    } else {
      worker.shutdown()
      check(!worker.start()) { "recreation overlapped blocked old worker" }
      lifecycleDone.countDown()
      producers(8, 2000)
    }
    check(lifecycleDone.await(2, TimeUnit.SECONDS))
    check(!worker.post {})
    check(gate.count == 1L)
    gate.countDown()
    waitFor { worker.start() }
    val restarted = CountDownLatch(1)
    worker.post { restarted.countDown() }
    check(restarted.await(2, TimeUnit.SECONDS))
    check(worker.starts.get() == 2)
    println("PASS $mode: bounded recreation, no joins/readiness waits, failed/closed admission counted; worstNs=$worst")
    return
  }
  DeepAsyncTrace.install(context); DeepAsyncTrace.startWorker()
  val entered = CountDownLatch(1); val gate = CountDownLatch(1)
  worker.post { entered.countDown(); gate.await() }
  check(entered.await(2, TimeUnit.SECONDS))
  @Suppress("UNCHECKED_CAST")
  val events = field("events") as RecorderQueue<Any>
  if (mode == "gate") {
    // Simulate a producer suspended after reserving the first ring slot.
    // No other producer may wait for that slot's publication.
    val reservation = events.javaClass.getDeclaredField("enqueue").apply { isAccessible = true }.get(events) as AtomicLong
    reservation.getAndIncrement()
    producers(8, 2000)
    check(events.dropped.get() > 0 && events.size <= 2048)
    println("PASS unpublished ring reservation: other producers finish with bounded, counted loss")
  } else {
    val worst = producers(if (mode == "stress") 8 else 1, if (mode == "stress") 20000 else 10000)
    check(events.size <= 2048 && events.highWater.get() <= 2048)
    check(events.dropped.get() > 0)
    check(gate.count == 1L)
    println("PASS $mode actual producers: worstNs=$worst eventDrops=${events.dropped.get()} queueHighWater=${events.highWater.get()} recorderFailures=${worker.failures.get()}")
  }
  gate.countDown()
}
