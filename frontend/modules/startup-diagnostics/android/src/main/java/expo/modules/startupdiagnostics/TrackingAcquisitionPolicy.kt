package expo.modules.startupdiagnostics

/** Pure admission policy; authority, leases and shared failure backoff run first. */
object TrackingAcquisitionPolicy {
  private const val MINUTE = 60000L

  fun interval(purpose: String, moving: Boolean): Long? = when (purpose) {
    "periodic" -> if (moving) 5 * MINUTE else 60 * MINUTE
    // A silent motion path cannot certify that the phone is still stationary.
    // A short probe on an EXISTING wake bounds that blind spot; no new timer.
    "watchdog" -> if (moving) 5 * MINUTE else 15 * MINUTE
    "recovery" -> 5 * MINUTE
    "explicit" -> 0L
    else -> null
  }

  fun recent(at: Long, now: Long, interval: Long): Boolean =
    at > 0 && at <= now && now - at < interval

  fun denial(purpose: String, moving: Boolean, capture: Long, now: Long,
    lastIntent: Long, lastWatchdog: Long): String? {
    val interval = interval(purpose, moving) ?: return "invalid_purpose"
    if (purpose == "watchdog" && recent(lastWatchdog, now, interval)) return "watchdog_cooldown"
    if ((purpose == "explicit" || purpose == "recovery") && recent(lastIntent, now, MINUTE)) {
      return "intent_cooldown"
    }
    return if (recent(capture, now, interval)) "capture_recent" else null
  }

  fun maintenanceDue(capture: Long, moving: Boolean, lastAttempt: Long, now: Long): Boolean =
    !recent(capture, now, interval("watchdog", moving)!!) && !recent(lastAttempt, now, 15 * MINUTE)
}
