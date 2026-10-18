import android.content.Context
import expo.modules.startupdiagnostics.TrackingReliability as Tracking
import org.json.JSONObject
import java.io.File

/** Executes the REAL production authority, with fake Android storage/clock. */
fun main(args: Array<String>) {
  val context = Context(File(args[0]))
  val owner = "test-owner:test-member"
  val now = System.currentTimeMillis()
  if (args[1] == "policy") {
    Tracking.authorize(context, owner, 0)
    check(Tracking.claim(context, owner, 0, "initial", now))
    var capture = now - 1
    Tracking.complete(context, "initial", "fresh_fix_delivered", capture, false)
    repeat(3) { cycle ->
      check(!Tracking.claim(context, owner, 0, "early", capture + 60 * 60000 - 1))
      check(Tracking.claim(context, owner, 0, "due-$cycle", capture + 60 * 60000))
      capture += 60 * 60000
      Tracking.complete(context, "due-$cycle", "fresh_fix_delivered", capture, false)
    }
    // The stationary age gate itself cannot withhold an eleven-hour-old fix.
    check(Tracking.claim(context, owner, 0, "eleven-hours", capture + 11 * 60 * 60000))
    Tracking.complete(context, "eleven-hours", "operation_discarded", 0, false)
    check(JSONObject(Tracking.read(context)).getLong("capturedAt") == capture)

    val moving = Context(File(args[0] + ".moving"))
    Tracking.authorize(moving, owner, 0)
    check(Tracking.claim(moving, owner, 0, "moving-seed", now))
    val movingCapture = System.currentTimeMillis() - 9 * 60000
    Tracking.complete(moving, "moving-seed", "fresh_fix_delivered", movingCapture, false)
    Tracking.movement(moving, owner, 0, true)
    check(!Tracking.claim(moving, owner, 0, "moving-early", movingCapture + 10 * 60000 - 1))
    check(Tracking.claim(moving, owner, 0, "moving-due", movingCapture + 10 * 60000))
    Tracking.complete(moving, "moving-due", "operation_discarded", 0, true)

    val failures = Context(File(args[0] + ".failures"))
    Tracking.authorize(failures, owner, 0)
    var at = now
    for ((index, minutes) in listOf(5, 15, 30).withIndex()) {
      val op = "failure-$index"
      check(Tracking.claim(failures, owner, 0, op, at))
      Tracking.complete(failures, op, "degraded", 0, false)
      val eligible = JSONObject(Tracking.read(failures)).getLong("nextEligibleAt")
      check(eligible - System.currentTimeMillis() in (minutes * 60000L - 1000)..(minutes * 60000L))
      check(!Tracking.claim(failures, owner, 0, "backoff-early", eligible - 1))
      at = eligible
    }
    println("PASS native stationary 60m/reset/11h eligibility, recent-moving 10m and 5/15/30m backoff")
    return
  }
  if (args[1] == "seed") {
    check(!JSONObject(Tracking.authorize(context, owner, 0)).getBoolean("revoked"))
    check(Tracking.claim(context, owner, 0, "gps", now))
    check(Tracking.claim(context, owner, 0, "config", now, true))
    check(!Tracking.claim(context, owner, 0, "overlap", now, true))
    Tracking.complete(context, "config", "operation_discarded", 0, false)
    check(JSONObject(Tracking.read(context)).getString("operation") == "gps")
    Tracking.complete(context, "gps", "degraded", 0, false)
    val cooldown = JSONObject(Tracking.read(context)).getLong("nextEligibleAt")
    check(cooldown > now)
    check(Tracking.claim(context, owner, 0, "config-during-backoff", now, true))
    Tracking.complete(context, "config-during-backoff", "operation_discarded", 0, false)
    check(JSONObject(Tracking.read(context)).getLong("nextEligibleAt") == cooldown)
    check(!Tracking.revokeIfCurrent(context, "obsolete-owner", 0, "consent", "wrong"))
    check(!JSONObject(Tracking.read(context)).getBoolean("revoked"))
    // Exit with a pending configuration. A NEW JVM must clean a dead process
    // incarnation, not simulate process death by resetting a JS module mock.
    check(Tracking.claim(context, owner, 0, "process-will-exit", now, true))
    println("PASS native config exclusion, preserved GPS/backoff, stale-owner CAS")
  } else {
    val recovered = JSONObject(Tracking.read(context))
    check(!recovered.has("pendingMutation"))
    check(recovered.getString("owner") == owner && !recovered.getBoolean("revoked"))
    check(Tracking.claim(context, owner, 0, "new-process", now, true))
    Tracking.complete(context, "new-process", "operation_discarded", 0, false)
    check(Tracking.revokeIfCurrent(context, owner, 0, "consent", "shutdown"))
    check(JSONObject(Tracking.read(context)).getBoolean("revoked"))
    check(!Tracking.claim(context, owner, 0, "obsolete-config", now, true))
    println("PASS native process-incarnation recovery and confirmed-revocation fence")
  }
}
