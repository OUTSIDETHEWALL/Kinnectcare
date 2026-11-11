package expo.modules.startupdiagnostics
import org.json.JSONObject

fun main() {
  var tests = 0
  fun verify(value: Boolean) { check(value); tests++ }
  fun event(reg: Long, stage: Int, elapsed: Long, flight: String = "flight") =
    JSONObject().put("registration", reg).put("stage", stage).put("elapsedNs", elapsed)
      .put("process", "old-process").put("js", "runtime").put("request", "request-$reg")
      .put("flight", flight).put("operation", "operation")
  val store = SchedulingRetention()
  store.accept(event(1, 8, 1000))
  store.accept(event(1, 11, 2000))
  // Simulated 46-minute pending interval: no real recurring timer or wait.
  val delayed = 46L * 60 * 1000000000L
  verify(store.export(delayed).getJSONArray("incidents").length() == 1)
  store.accept(event(1, 14, delayed))
  store.accept(event(1, 16, delayed + 1000))
  store.accept(event(1, 17, delayed + 2000))
  for (i in 2L..3000) {
    store.accept(event(i, 8, delayed + i, "normal-$i"))
    store.accept(event(i, 17, delayed + i + 1, "normal-$i"))
  }
  val result = store.export(delayed + 100000)
  verify(result.getJSONArray("timers").length() <= 128)
  verify(result.getJSONArray("incidents").length() == 1)
  val pinned = result.getJSONArray("incidents").getJSONObject(0).getJSONArray("timers").getJSONObject(0)
  verify(pinned.has("stage8") && pinned.has("stage11") && pinned.has("stage16") && pinned.has("stage17"))
  verify(pinned.getJSONObject("creation").getLong("elapsedNs") == 1000L)
  for (i in 2L..8) { store.accept(event(10000+i, 8, 1000, "pathological-$i")); store.accept(event(10000+i, 17, delayed, "pathological-$i")) }
  verify(store.export(delayed).getJSONArray("incidents").length() == 4)
  val saved = store.export(delayed)
  verify(saved.toString().toByteArray().size < 512 * 1024)
  val restore = SchedulingRetention(); restore.restore(JSONObject(saved.toString()))
  verify(restore.export(delayed).getJSONArray("incidents").length() == 4)
  store.correlate(listOf(
    JSONObject().put("kind", "operation").put("id", "operation").put("flight", "flight"),
    JSONObject().put("kind", "operation").put("id", "follower").put("flight", "flight"),
    JSONObject().put("kind", "flight").put("id", "flight")))
  val capsule = store.export(delayed).getJSONArray("incidents").getJSONObject(0)
  verify(capsule.getBoolean("followerRetained"))
  verify(capsule.getJSONObject("references").has("flight:flight"))
  for (i in 0 until 100) store.correlate(listOf(
    JSONObject().put("kind", "operation").put("id", "follower$i").put("flight", "flight")))
  verify(capsule.getJSONObject("references").length() <= 8)
  store.compact()
  verify(store.export(delayed).getJSONArray("incidents").length() == 4)
  val criticalOnly = JSONObject().put("incidents", store.export(delayed).getJSONArray("incidents"))
  val criticalRestore = SchedulingRetention(); criticalRestore.restore(criticalOnly)
  verify(criticalRestore.export(delayed).getJSONArray("incidents").getJSONObject(0).getJSONArray("timers").length() > 0)
  println("PASS $tests retention assertions: 46-minute delay, late success, 3000-request flood, bounded pool, restore")
  println("LIMIT: pure retention worker contract, not Android persistence durability")
}
