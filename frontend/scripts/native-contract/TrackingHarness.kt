import android.content.Context
import expo.modules.startupdiagnostics.TrackingReliability as Tracking
import org.json.JSONObject
import java.io.File

/** Executes the REAL production authority, with fake Android storage/clock. */
fun main(args: Array<String>) {
  val context = Context(File(args[0]))
  val owner = "test-owner:test-member"
  val now = System.currentTimeMillis()
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
