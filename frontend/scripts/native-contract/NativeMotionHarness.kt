import expo.modules.startupdiagnostics.NativeMotionPolicy as Policy

fun main() {
  fun allowed(owner: String = "user:member", gen: Long = 8, revoked: Boolean = false,
    shutdown: Boolean = false, mutation: Boolean = false, bound: String = owner,
    boundGen: Long = gen, permissions: Boolean = true) =
    Policy.allowed(owner, gen, revoked, shutdown, mutation, bound, boundGen, permissions)
  check(allowed())
  check(!allowed(owner = ""))
  check(!allowed(owner = "unbound"))
  check(!allowed(revoked = true))
  check(!allowed(shutdown = true))
  check(!allowed(mutation = true))
  check(!allowed(bound = "previous:member"))
  check(!allowed(boundGen = 7))
  check(!allowed(permissions = false))
  check(!allowed(gen = -1))
  val now = 10_000_000_000_000L
  check(Policy.freshTransition(now - 1, 0, now))
  check(!Policy.freshTransition(now + 1, 0, now))
  check(!Policy.freshTransition(now - 121_000_000_000L, 0, now))
  check(!Policy.freshTransition(now - 1, now - 1, now))
  // elapsed clock reset at reboot must not permanently suppress new motion.
  check(Policy.freshTransition(now - 1, now + 1, now))
  println("PASS native motion admission, privacy, replacement, mutation, replay and reboot-clock policy")
}
