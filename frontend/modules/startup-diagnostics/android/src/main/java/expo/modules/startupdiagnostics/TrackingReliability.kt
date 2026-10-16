package expo.modules.startupdiagnostics

import android.content.Context
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** One process-wide lock covers every React/headless runtime. commit(), not apply(). */
object TrackingReliability {
  private val lock = Any()
  private val processIncarnation = UUID.randomUUID().toString()
  private var failedRevocation: String? = null
  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences("kinnship_tracking_reliability_v1", Context.MODE_PRIVATE)
  private fun state(context: Context): JSONObject {
    val s = JSONObject(failedRevocation ?: prefs(context).getString("state", """{"generation":0,"owner":"","revoked":true}""")!!)
    // A dead process cannot deliver an old native callback. A living process
    // must keep mutating native work quarantined even after the GPS lease ends.
    if (s.has("pendingMutation") && s.optString("mutationProcess") != processIncarnation) {
      s.remove("pendingMutation")
      s.remove("mutationProcess")
      if (s.optBoolean("revoked", true)) s.put("shutdownPending", true)
      save(context, s)
    }
    val shutdowns = s.optJSONObject("shutdowns")
    if (shutdowns != null) {
      val dead = mutableListOf<String>()
      val keys = shutdowns.keys()
      while (keys.hasNext()) {
        val key = keys.next()
        if (shutdowns.optString(key) != processIncarnation) dead.add(key)
      }
      if (dead.isNotEmpty()) {
        for (key in dead) shutdowns.remove(key)
        if (s.optBoolean("revoked", true)) s.put("shutdownPending", true)
        save(context, s)
      }
    }
    return s
  }
  private fun save(context: Context, value: JSONObject) {
    check(prefs(context).edit().putString("state", value.toString()).commit()) { "tracking_commit_failed" }
    failedRevocation = null
  }

  fun read(context: Context): String = synchronized(lock) { state(context).toString() }

  fun authorize(context: Context, owner: String, expectedGeneration: Long): String = synchronized(lock) {
    val s = state(context)
    if (s.getLong("generation") != expectedGeneration) return@synchronized s.toString()
    if (s.optBoolean("revoked", true) && s.optString("reason") == "consent") return@synchronized s.toString()
    if (s.optBoolean("shutdownPending", false)) return@synchronized s.toString()
    if (s.has("pendingMutation")) return@synchronized s.toString()
    if ((s.optJSONObject("shutdowns")?.length() ?: 0) > 0) return@synchronized s.toString()
    if (s.optString("owner").isNotEmpty() && s.optString("owner") != owner) {
      // Replacement must revoke/shut down the old binding before authorization.
      return@synchronized s.toString()
    }
    s.put("owner", owner).put("revoked", false)
    save(context, s)
    s.toString()
  }

  fun revoke(context: Context, reason: String): String = synchronized(lock) {
    revokeState(context, reason).toString()
  }

  /** Compare, invalidate and reserve shutdown in ONE cross-runtime critical section. */
  fun revokeIfCurrent(context: Context, owner: String, generation: Long, reason: String,
    operation: String): Boolean = synchronized(lock) {
    val s = state(context)
    if (s.getLong("generation") != generation || s.optString("owner") != owner) return@synchronized false
    revokeState(context, reason, operation)
    true
  }

  fun rearmConsent(context: Context, generation: Long): Boolean = synchronized(lock) {
    val s = state(context)
    if (s.getLong("generation") != generation || !s.optBoolean("revoked", true)) return@synchronized false
    if (s.optString("reason") == "consent") {
      s.put("reason", "stopped")
      save(context, s)
    }
    true
  }

  private fun revokeState(context: Context, reason: String, operation: String? = null): JSONObject {
    val old = state(context)
    val generation = old.getLong("generation") + 1
    // Freshness, movement and cooldown belong to the revoked owner, not whoever
    // authorizes next. Retain history only in the separate diagnostic journal.
    val s = JSONObject().put("generation", generation).put("revoked", true)
      .put("shutdownPending", true).put("owner", "")
      .put("reason", if (old.optString("reason") == "consent") "consent" else reason)
      .put("revokedOwner", old.optString("owner"))
    if (old.has("pendingMutation")) {
      s.put("pendingMutation", old.get("pendingMutation")).put("mutationProcess", processIncarnation)
    }
    if (old.has("shutdowns")) s.put("shutdowns", old.get("shutdowns"))
    if (operation != null) {
      val shutdowns = s.optJSONObject("shutdowns") ?: JSONObject()
      shutdowns.put(operation, processIncarnation)
      s.put("shutdowns", shutdowns)
    }
    // Disk failure must not resurrect publication rights in another live JS
    // runtime. Failed persistence stays explicit and new authorization fails closed.
    failedRevocation = s.toString()
    save(context, s)
    try {
      record(context, "stop_intent", JSONObject().put("reason", reason).put("generation", s.getLong("generation")).toString())
    } catch (_: Exception) { /* diagnostic failure cannot interrupt reserved shutdown */ }
    return s
  }

  fun shutdownComplete(context: Context, generation: Long) = synchronized(lock) {
    val s = state(context)
    if (s.getLong("generation") != generation || !s.optBoolean("revoked", true)) return@synchronized
    if ((s.optJSONObject("shutdowns")?.length() ?: 0) > 0) return@synchronized
    s.put("shutdownPending", false)
    save(context, s)
  }

  fun shutdownBegin(context: Context, generation: Long, operation: String): Boolean = synchronized(lock) {
    val s = state(context)
    if (!s.optBoolean("revoked", true) || s.getLong("generation") != generation) return@synchronized false
    val shutdowns = s.optJSONObject("shutdowns") ?: JSONObject()
    shutdowns.put(operation, processIncarnation)
    s.put("shutdowns", shutdowns).put("shutdownPending", true)
    // A disk error cannot prevent the SDK stop command or allow live rebinding.
    try { save(context, s) } catch (_: Exception) { failedRevocation = s.toString() }
    true
  }

  fun shutdownEnd(context: Context, operation: String, success: Boolean) = synchronized(lock) {
    val s = state(context)
    val shutdowns = s.optJSONObject("shutdowns") ?: return@synchronized
    if (!shutdowns.has(operation)) return@synchronized
    shutdowns.remove(operation)
    if (s.optBoolean("revoked", true)) {
      if (!success) s.put("shutdownPending", true)
      else if (shutdowns.length() == 0) s.put("shutdownPending", false)
    }
    try { save(context, s) } catch (_: Exception) { failedRevocation = s.toString() }
  }

  fun claim(context: Context, owner: String, generation: Long, operation: String, now: Long,
    configurationOnly: Boolean = false): Boolean = synchronized(lock) {
    val s = state(context)
    val elapsed = SystemClock.elapsedRealtime()
    if (s.optBoolean("revoked", true) || s.getLong("generation") != generation || s.optString("owner") != owner) return@synchronized false
    if (s.has("pendingMutation")) return@synchronized false
    // elapsedRealtime protects leases within a boot. Wall time supports cooldown
    // across reboot; future/invalid clocks never suppress work indefinitely.
    val claimed = s.optLong("claimedElapsed", 0)
    if (s.has("operation") && elapsed >= claimed && elapsed - claimed < 60000) return@synchronized false
    val next = s.optLong("nextEligibleAt", 0)
    if (next > now && next - now <= 30 * 60000) return@synchronized false
    val capture = s.optLong("capturedAt", 0)
    val movement = s.optLong("movementAt", 0)
    val recentMoving = s.optBoolean("moving", false) && movement <= now && now - movement < 10 * 60000
    val threshold = if (recentMoving) 10 * 60000 else 60 * 60000
    if (!configurationOnly && capture > 0 && capture <= now && now - capture < threshold) return@synchronized false
    s.put("operation", operation).put("claimedElapsed", elapsed)
    if (configurationOnly) s.put("pendingMutation", operation).put("mutationProcess", processIncarnation)
    save(context, s)
    true
  }

  fun complete(context: Context, operation: String, outcome: String, capturedAt: Long, moving: Boolean) = synchronized(lock) {
    val s = state(context)
    if (s.optString("pendingMutation") == operation) {
      s.remove("pendingMutation")
      s.remove("mutationProcess")
      save(context, s)
    }
    if (s.optString("operation") != operation || s.optBoolean("revoked", true)) return@synchronized
    s.remove("operation")
    if (outcome != "operation_discarded") s.put("outcome", outcome)
    if (outcome == "operation_discarded") {
      // Cancellation is not an acquisition failure or an owner revocation.
    } else if (outcome == "fresh_fix_delivered") {
      s.put("failures", 0).put("nextEligibleAt", 0)
      s.put("capturedAt", capturedAt).put("moving", moving).put("movementAt", capturedAt)
    } else {
      val failures = s.optInt("failures", 0) + 1
      val minutes = if (failures == 1) 5 else if (failures == 2) 15 else 30
      s.put("failures", failures).put("nextEligibleAt", System.currentTimeMillis() + minutes * 60000L)
    }
    save(context, s)
    record(context, "recovery_outcome", JSONObject().put("operation", operation).put("outcome", outcome)
      .put("capturedAt", capturedAt).put("nextEligibleAt", s.optLong("nextEligibleAt")).toString())
  }

  fun observe(context: Context, owner: String, generation: Long, capturedAt: Long, moving: Boolean) = synchronized(lock) {
    val s = state(context)
    if (s.optBoolean("revoked", true) || s.optString("owner") != owner || s.getLong("generation") != generation) return@synchronized
    if (capturedAt <= s.optLong("capturedAt", 0)) return@synchronized
    s.put("capturedAt", capturedAt).put("moving", moving).put("movementAt", capturedAt)
    // A subsequent accepted tuple read under the current owner is separate
    // from a forced fix. It still does not prove sustained tracking.
    s.put("ordinaryDeliveryAt", capturedAt).put("outcome", "recent_location_verified")
      .put("failures", 0).put("nextEligibleAt", 0)
    save(context, s)
  }

  fun movement(context: Context, owner: String, generation: Long, moving: Boolean) = synchronized(lock) {
    val s = state(context)
    if (s.optBoolean("revoked", true) || s.optString("owner") != owner || s.getLong("generation") != generation) return@synchronized
    s.put("moving", moving).put("movementAt", System.currentTimeMillis())
    save(context, s)
  }

  fun record(context: Context, event: String, detail: String) = synchronized(lock) {
    val safe = JSONObject()
    val input = JSONObject(detail)
    // Closed metadata inventory: never accept tokens, payloads or coordinates.
    val allowed = setOf("reason", "caller", "authorization", "source", "generation", "owner", "operation",
      "enabled", "outcome", "capturedAt", "nextEligibleAt", "fgsDenied", "httpAccepted", "coordinateAccepted")
    for (key in allowed) if (input.has(key)) safe.put(key, input.get(key))
    val records = JSONArray(prefs(context).getString("records", "[]"))
    records.put(JSONObject().put("at", System.currentTimeMillis()).put("event", event.take(80)).put("detail", safe))
    val bounded = JSONArray()
    for (i in maxOf(0, records.length() - 100) until records.length()) bounded.put(records.get(i))
    check(prefs(context).edit().putString("records", bounded.toString()).commit())
  }

  fun evidence(context: Context): String = synchronized(lock) {
    JSONObject().put("state", state(context)).put("records", JSONArray(prefs(context).getString("records", "[]"))).toString()
  }
}
