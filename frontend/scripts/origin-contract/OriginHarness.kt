import android.content.Context
import android.os.Handler
import android.os.SystemClock
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.network.NetworkingModule
import com.sun.net.httpserver.HttpServer
import expo.modules.startupdiagnostics.RequestOrigins as Origins
import expo.modules.startupdiagnostics.NativeHttpEvidence
import com.transistorsoft.rnbackgroundgeolocation.KinnshipOriginBridge as Bridge
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.*
import org.json.JSONObject

private fun snapshot(): JSONObject = JSONObject(Origins.read())
private fun await(check: () -> Boolean) {
  val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
  while (!check()) { check(System.nanoTime() < deadline) { "observer did not drain" }; Thread.sleep(10) }
}
fun main(args: Array<String>) {
  val root = File(args[0]).apply { mkdirs() }
  val context = Context(root)
  if (args[1] == "recreate") {
    Origins.install(context)
    val previous = snapshot()
    check(previous.getJSONArray("tasks").length() >= 1)
    val oldProcesses = previous.getJSONArray("tasks").let { rows -> (0 until rows.length()).map { rows.getJSONObject(it).getString("process") }.toSet() }
    val id = previous.getJSONArray("tasks").getJSONObject(0).getString("id")
    Origins.record("task", id, "queued", """{"taskId":29,"wake":"$id"}""")
    await { snapshot().getJSONArray("tasks").length() > previous.getJSONArray("tasks").length() }
    val next = snapshot()
    check(next.getString("process") !in oldProcesses)
    println("PASS process recreation: identical IDs remain separated by native process")
    return
  }
  NativeHttpEvidence.install(context)
  val delegateStarts = AtomicInteger()
  val delegateEnds = AtomicInteger()
  val delegateCanceled = AtomicInteger()
  val builder = OkHttpClient.Builder().eventListenerFactory {
    object : EventListener() {
      override fun callStart(call: Call) { delegateStarts.incrementAndGet() }
      override fun callEnd(call: Call) { delegateEnds.incrementAndGet() }
      override fun callFailed(call: Call, ioe: IOException) { delegateEnds.incrementAndGet() }
      override fun canceled(call: Call) { delegateCanceled.incrementAndGet() }
    }
  }
  val before = builder.build()
  NetworkingModule.apply(builder)
  val client = builder.build()
  check(before.dispatcher === client.dispatcher && before.connectionPool === client.connectionPool)
  check(before.callTimeoutMillis == client.callTimeoutMillis && before.retryOnConnectionFailure == client.retryOnConnectionFailure)
  val serverGate = CountDownLatch(1)
  val firstFive = CountDownLatch(5)
  val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
  val executor = Executors.newFixedThreadPool(8) { runnable -> Thread(runnable).apply { isDaemon = true } }
  server.executor = executor
  server.createContext("/api/") { exchange ->
    firstFive.countDown()
    serverGate.await(10, TimeUnit.SECONDS)
    check(exchange.requestHeaders.keys.none { it.startsWith("X-Kinnship") })
    val body = "{}".toByteArray()
    exchange.sendResponseHeaders(200, body.size.toLong())
    exchange.responseBody.use { it.write(body) }
  }
  server.start()
  val done = CountDownLatch(120)
  val paths = listOf("auth/me", "members", "me/preferences")
  val start = System.nanoTime()
  for (i in 1..120) {
    Origins.bind(context, i, """{"origin":"sdk-headless","phase":"second-ownership","operation":"op-${(i-1)/3}","wake":"wake-${(i-1)/3}","runtime":"runtime-a","request":"request-$i"}""")
    val request = Request.Builder().url("http://127.0.0.1:${server.address.port}/api/${paths[(i-1)%3]}").tag(i).build()
    val call = client.newCall(request)
    check(call.request() === request && call.request().tag() == i)
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) { done.countDown() }
      override fun onResponse(call: Call, response: Response) { response.close(); done.countDown() }
    })
  }
  check(firstFive.await(5, TimeUnit.SECONDS))
  check(client.dispatcher.queuedCallsCount() >= 100)
  serverGate.countDown()
  check(done.await(10, TimeUnit.SECONDS))
  await { snapshot().getJSONArray("requests").length() == 120 && delegateEnds.get() == 120 }
  val rows = snapshot().getJSONArray("requests")
  var maxQueued = 0
  for (i in 0 until rows.length()) {
    val row = rows.getJSONObject(i)
    check(row.getString("phase") == "second-ownership")
    check(row.has("created") && row.has("native_start") && row.has("entered") && row.has("ended"))
    check(row.getJSONObject("native_start").getLong("elapsed") <= row.getJSONObject("entered").getLong("elapsed"))
    maxQueued = maxOf(maxQueued, row.getJSONObject("native_start").getInt("queued"))
  }
  check(snapshot().getLong("queueDropped") == 0L)
  check(maxQueued >= 100)
  val census = snapshot().getJSONArray("queueSnapshots").getJSONObject(0)
  val codes = census.getString("queueCodes").split(" ")
  check(census.getJSONObject("queued").getInt("queued") >= 100)
  check(!census.getBoolean("queueTruncated") && census.getInt("queueMissing") == 0)
  check(codes.all { code -> (0 until rows.length()).any { rows.getJSONObject(it).getString("id").endsWith("-$code") } })
  check(delegateStarts.get() == 120 && delegateEnds.get() == 120)
  println("PASS 120 real OkHttp calls: linked creation/start/entry/end, queue peak >=100, all delegates preserved (${(System.nanoTime()-start)/1000000}ms)")

  Origins.bind(context, 1001, """{"origin":"cancellation-control"}""")
  val canceled = client.newCall(Request.Builder().url("http://127.0.0.1:${server.address.port}/api/auth/me").tag(1001).build())
  canceled.cancel()
  val canceledDone = CountDownLatch(1)
  canceled.enqueue(object : Callback {
    override fun onFailure(call: Call, e: IOException) { canceledDone.countDown() }
    override fun onResponse(call: Call, response: Response) { response.close(); error("canceled request executed") }
  })
  check(canceledDone.await(5, TimeUnit.SECONDS))
  await { snapshot().getJSONArray("requests").length() == 121 }
  val canceledRows = snapshot().getJSONArray("requests")
  val canceledRow = canceledRows.getJSONObject(canceledRows.length() - 1)
  check(canceledRow.has("canceled") && canceledRow.has("failed"))
  check(delegateCanceled.get() == 1)
  println("PASS cancellation/failure observed; original delegate and RN integer tag preserved")

  // Native task/wake correlation uses the production generated bridge.
  val wake = "c".repeat(32)
  val params = object : ReadableMap {
    override fun getString(name: String) = wake
    override fun getInt(name: String) = 29
  }
  Bridge.task(context, params, "queued", 0, 120000)
  Bridge.task(context, params, "invoked", 77, 120000)
  SystemClock.offset += 120010
  Bridge.task(null, params, "removed", 77, 120000)
  Origins.record("task", wake, "js_settled", """{"wake":"$wake","taskId":29,"runtime":"runtime-a"}""")
  Bridge.finish(context, 29)
  Bridge.missing(context, 29)
  await { snapshot().getJSONArray("tasks").length() == 2 }
  val taskRows = snapshot().getJSONArray("tasks")
  val task = taskRows.getJSONObject(0)
  check(task.getBoolean("deadlineReachedAtRemoval"))
  check(task.getInt("taskId") == 29 && task.getInt("reactTaskId") == 77 && task.has("js_settled"))
  check(task.getJSONObject("removed").getLong("elapsed") <= task.getJSONObject("js_settled").getLong("elapsed"))
  check(taskRows.getJSONObject(1).has("missing_finish"))
  println("PASS native SDK task -> wake -> deadline/removal -> JS settlement -> missing finish")

  // Numeric RN request collisions cannot acquire another runtime's origin.
  Origins.bind(context, 900, """{"origin":"first-runtime","runtime":"one"}""")
  Origins.bind(Context(root), 900, """{"origin":"second-runtime","runtime":"two"}""")
  repeat(2) {
    val call = client.newCall(Request.Builder().url("http://127.0.0.1/api/auth/me").tag(900).build())
    // Factory has consumed binding; no HTTP request needs to be sent.
    check(Origins.tag(call)?.detail?.contains("unattributed") == true)
    Origins.finish(call)
  }
  check(snapshot().getLong("bindingDropped") >= 2)
  println("PASS overlapping RN ID collisions are explicitly unattributed, not falsely merged")

  // A blocked diagnostic consumer must not block producers or grow memory.
  val gate = CountDownLatch(1)
  Handler.block = gate
  Thread.sleep(25)
  val producerStart = System.nanoTime()
  repeat(10000) { Origins.record("operation", "overflow-$it", "created", """{"origin":"stress","token":"secret","latitude":33.123456}""") }
  val producerMs = (System.nanoTime() - producerStart) / 1000000
  check(producerMs < 1500) { "blocked consumer blocked producer: ${producerMs}ms" }
  Handler.block = null
  gate.countDown()
  await { snapshot().optInt("pendingEvents", -1) == 0 }
  val overflow = snapshot()
  check(overflow.getLong("queueDropped") > 0)
  check(overflow.getJSONArray("operations").length() <= 256)
  check(overflow.getLong("evictedRecords") > 0)
  check(!overflow.toString().contains("secret") && !overflow.toString().contains("33.123456"))
  Thread.sleep(1200)
  check(File(root, "request-origins-v1.json").length() <= 2 * 1024 * 1024)
  println("PASS 10,000-event blocked consumer: ${producerMs}ms producer time; explicit overflow, bounded retention, privacy filtering")

  // Force asynchronous storage failure, leaving successful application work alone.
  val target = File(root, "request-origins-v1.json.tmp")
  target.delete()
  target.mkdir()
  File(target, "deny").writeText("blocked")
  val failureBefore = snapshot().getLong("observerFailures")
  Origins.record("operation", "io-failure", "created", """{"origin":"stress"}""")
  Thread.sleep(1200)
  check(snapshot().getLong("observerFailures") > failureBefore)
  File(target, "deny").delete(); target.delete()
  println("PASS storage failure is asynchronous, counted, and does not escape producers")
  server.stop(0); executor.shutdownNow()
  client.dispatcher.executorService.shutdownNow(); client.connectionPool.evictAll()
}
