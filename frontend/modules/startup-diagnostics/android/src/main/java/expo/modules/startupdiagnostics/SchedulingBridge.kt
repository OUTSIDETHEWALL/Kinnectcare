package expo.modules.startupdiagnostics

/** Linked by the instrumented RN .so. Activation is an independent RN lifecycle call. */
object SchedulingBridge {
  @Volatile private var active = false
  @JvmStatic fun activate() {
    // Independent instance initialization resolves producer JNI symbols here.
    // No live registration, queue event, disk or worker start.
    try {
      beginNative("", "", "", "", 0)
      endNative(0, -1)
      callbackNative(0)
      progressNative(-1)
      active = true
    } catch (_: Throwable) { active = false }
  }
  @JvmStatic fun available(): Boolean = active
  @JvmStatic external fun beginNative(request: String, operation: String, flight: String, js: String, kind: Int): Long
  @JvmStatic external fun endNative(registration: Long, handle: Long)
  @JvmStatic external fun callbackNative(registration: Long)
  @JvmStatic external fun progressNative(category: Int)
  @JvmStatic external fun drainNative(): String
  fun begin(request: String, operation: String, flight: String, js: String, kind: Int): Long =
    if (active) try { beginNative(request, operation, flight, js, kind) } catch (_: Throwable) { 0L } else 0L
  fun end(registration: Long, handle: Long) {
    if (active) try { endNative(registration, handle) } catch (_: Throwable) { }
  }
  fun callback(registration: Long) {
    if (active && registration > 0L) try { callbackNative(registration) } catch (_: Throwable) { }
  }
  fun progress(category: Int) {
    if (active) try { progressNative(category) } catch (_: Throwable) { }
  }
}
