import android.content.Context
import android.os.Handler
import android.os.SystemClock
import expo.modules.startupdiagnostics.DeepAsyncTrace as Trace
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

private fun id(n: Int) = n.toString(16).padStart(32, '0')
private fun await(check: () -> Boolean) {
  val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
  while (!check()) { check(System.nanoTime() < deadline) { "deep observer did not drain" }; Thread.sleep(20) }
}
fun main(args: Array<String>) {
  val context = Context(File(args[0]).apply { mkdirs() })
  Trace.install(context)
  Trace.record("operation", id(1), "ownership_entered", """{"origin":"sdk-headless","wake":"${id(90)}"}""")
  Trace.record("operation", id(2), "contact_unshared_entered", """{"origin":"workmanager","wake":"${id(91)}"}""")
  Trace.record("operation", id(1), "consumer_attached", """{"flight":"${id(3)}"}""")
  Trace.record("flight", id(3), "flight_created", """{"operation":"${id(1)}","count":1}""")
  Trace.record("operation", id(4), "consumer_attached", """{"flight":"${id(3)}","origin":"sdk-headless"}""")
  Trace.record("request", id(5), "body_read_entered", """{"operation":"${id(1)}","endpoint":"members"}""")
  Trace.record("request", id(6), "native_ended", """{"operation":"${id(2)}","endpoint":"auth-me"}""")
  await { JSONObject(Trace.read()).getJSONArray("entities").length() >= 6 }
  val gate = CountDownLatch(1)
  Handler.block = gate
  val start = System.nanoTime()
  for (i in 100..20100) Trace.record("request", id(i), "helper_exited", """{"operation":"${id(i + 30000)}"}""")
  check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 2000) { "producer blocked on writer" }
  gate.countDown(); Handler.block = null
  await { JSONObject(Trace.read()).optLong("observerDrops") > 0 }
  for (i in 21000..21900) Trace.record("request", id(i), "helper_exited", "{}")
  await { JSONObject(Trace.read()).optLong("evicted") > 0 }
  val state = JSONObject(Trace.read())
  val rows = state.getJSONArray("entities")
  check(rows.length() <= 512)
  val retained = (0 until rows.length()).map { rows.getJSONObject(it).getString("id") }.toSet()
  for (n in 1..6) check(id(n) in retained) { "pathological root/child/follower lost: $n" }
  check((0 until rows.length()).all { rows.getJSONObject(it).getJSONArray("history").length() <= 32 })
  val record = (0 until rows.length()).map { rows.getJSONObject(it) }.first { it.getString("id") == id(6) }
  check(record.getJSONObject("last").getString("stage") == "native_ended")
  check(!record.has("flight"))
  check(state.optLong("bindingDrops") == 0L)
  SystemClock.offset += 3 * 3600000L
  Trace.record("operation", id(1), "ownership_returned", "{}")
  Trace.record("operation", id(2), "contact_returned", "{}")
  for (i in 24000..24800) Trace.record("operation", id(i), "ownership_returned", """{"origin":"sdk-headless"}""")
  await {
    val latest = JSONObject(Trace.read()).getJSONArray("entities")
    (0 until latest.length()).any { latest.getJSONObject(it).getString("id") == id(1)
      && latest.getJSONObject(it).optBoolean("everPathological") }
  }
  val after = JSONObject(Trace.read()).getJSONArray("entities")
  val afterIds = (0 until after.length()).map { after.getJSONObject(it).getString("id") }.toSet()
  for (n in 1..6) check(id(n) in afterIds) { "late resumption/export flood erased evidence: $n" }
  println("PASS native bounded stress, blocked writer fail-open, oldest SDK/WM roots, flight/follower/requests, native-only boundary retained")
  println("PASS pathological evidence remains pinned after late resumption and foreground flood")
  // Thread-backed Android stub is daemonized. No production timer/cadence change.
}
