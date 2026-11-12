package expo.modules.startupdiagnostics

/** Pure, fail-closed admission policy shared by boot and real motion broadcasts. */
object NativeMotionPolicy {
  fun allowed(owner: String, generation: Long, revoked: Boolean, shutdown: Boolean,
    mutations: Boolean, boundOwner: String, boundGeneration: Long, permissions: Boolean): Boolean =
    permissions && owner.split(":").size == 2 && owner.split(":").all { it.isNotBlank() } &&
      generation >= 0 && !revoked && !shutdown && !mutations &&
      owner == boundOwner && generation == boundGeneration

  fun freshTransition(eventNanos: Long, lastNanos: Long, nowNanos: Long): Boolean =
    eventNanos > 0 && eventNanos <= nowNanos && nowNanos - eventNanos <= 120_000_000_000L &&
      (lastNanos > nowNanos || eventNanos > lastNanos)
}
