import android.content.Context
import expo.modules.startupdiagnostics.TrackingReliability as Tracking
import expo.modules.startupdiagnostics.TrackingAcquisitionPolicy as Policy
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

/** Real production native gate, with fake Android storage/monotonic clock. */
fun main(args: Array<String>) {
  val now = System.currentTimeMillis()
  val minute = 60000L
  val owner = "gps-owner:gps-member"
  fun context(name: String): Context = Context(File("${args[0]}-$name")).also {
    Tracking.authorize(it, owner, 0)
  }
  fun claim(c: Context, op: String, purpose: String, at: Long = now) =
    Tracking.claim(c, owner, 0, op, at, false, "test", purpose)
  val c = context("purposes")
  Tracking.observe(c, owner, 0, now - 43 * minute, false)
  check(!claim(c, "ordinary", "periodic"))
  check(claim(c, "watchdog", "watchdog"))
  check(!claim(c, "concurrent-explicit", "explicit"))
  Tracking.complete(c, "watchdog", "fresh_fix_delivered", now, false)
  check(claim(c, "explicit", "explicit")) // same fresh capture, still an intentional request
  Tracking.complete(c, "explicit", "operation_discarded", 0, false)
  check(!claim(c, "repeat", "explicit"))
  check(claim(c, "next-intent", "explicit", now + minute))
  Tracking.complete(c, "next-intent", "degraded", 0, false)
  val before = JSONObject(Tracking.read(c))
  for (purpose in listOf("periodic", "watchdog", "explicit", "recovery")) {
    check(!claim(c, "backoff-$purpose", purpose))
  }
  check(JSONObject(Tracking.read(c)).getLong("nextEligibleAt") == before.getLong("nextEligibleAt"))
  check(!Tracking.claim(c, "wrong:owner", 0, "wrong", now, false, "", "explicit"))
  check(!Tracking.claim(c, owner, 1, "wrong-gen", now, false, "", "explicit"))

  val maintenance = context("maintenance")
  Tracking.observe(maintenance, owner, 0, now - minute, false)
  check(Tracking.claimMotionMaintenance(maintenance, owner, 0, now) { error("fresh GPS") } == "not_due")
  val binds = AtomicInteger(0)
  // Arrival after a long silent stationary period is grounds for a bounded
  // health probe, not proof that Android battery optimization caused it.
  val later = now + 15 * minute
  val start = CountDownLatch(1)
  val threads = (1..24).map {
    Thread {
      start.await()
      Tracking.claimMotionMaintenance(maintenance, owner, 0, later) { binds.incrementAndGet() }
    }.also { it.start() }
  }
  start.countDown()
  threads.forEach { it.join() }
  check(binds.get() == 1)
  check(Tracking.claimMotionMaintenance(maintenance, owner, 0, later + 15 * minute - 1) {
    error("unbounded registration")
  } == "not_due")
  check(Tracking.claimMotionMaintenance(maintenance, owner, 0, later + 15 * minute) {
    binds.incrementAndGet()
  } == "requested")
  check(binds.get() == 2)
  check(Tracking.claim(maintenance, owner, 0, "config", later, true))
  check(Tracking.claimMotionMaintenance(maintenance, owner, 0, later + 30 * minute) {
    error("mutation pending")
  } == "not_authorized")
  Tracking.complete(maintenance, "config", "operation_discarded", 0, false)
  Tracking.revoke(maintenance, "consent")
  check(Tracking.claimMotionMaintenance(maintenance, owner, 0, later + 30 * minute) {
    error("revoked")
  } == "not_authorized")
  check(!claim(maintenance, "revoked", "explicit", later + 30 * minute))

  // Native single-flight, even across simultaneous foreground/headless calls.
  val parallel = context("parallel")
  val admitted = AtomicInteger(0)
  val ready = CountDownLatch(1)
  val races = (1..24).map { i ->
    Thread { ready.await(); if (claim(parallel, "race-$i", "explicit")) admitted.incrementAndGet() }
      .also { it.start() }
  }
  ready.countDown()
  races.forEach { it.join() }
  check(admitted.get() == 1)
  for (moving in listOf(true, false)) {
    val watchdog = if (moving) 5 * minute else 15 * minute
    check(Policy.denial("watchdog", moving, now - watchdog + 1, now, 0, 0) == "capture_recent")
    check(Policy.denial("watchdog", moving, now - watchdog, now, 0, 0) == null)
    check(Policy.denial("watchdog", moving, 0, now, 0, now - 1) == "watchdog_cooldown")
  }
  check(Policy.denial("recovery", false, now - 5 * minute, now, 0, 0) == null)
  check(Policy.denial("invalid", false, 0, now, 0, 0) == "invalid_purpose")
  check(Policy.denial("explicit", false, now, now, now + 6000, 0) == null)
  check(Policy.maintenanceDue(now + 6000, false, now + 6000, now))
  println("PASS real native purpose admission, exact deadlines, stationary watchdog, concurrent leases, shared backoff, bounded registration and revocation")
}
