package expo.modules.startupdiagnostics

import android.os.SystemClock
import java.util.UUID
import java.util.function.BooleanSupplier

/**
 * Execution liveness, NOT tracking/consent authority. Never persisted or restored.
 * Independent of the evictable diagnostic rings and their IO/observer locks.
 */
object HeadlessTaskLifetimes {
  private val lock = Any()
  private data class Execution(val deadline: Long, val running: BooleanSupplier)
  private val executions = HashMap<String, Execution>()

  @JvmStatic
  fun begin(timeoutMs: Int, running: BooleanSupplier): String = synchronized(lock) {
    val now = SystemClock.elapsedRealtime()
    executions.entries.removeAll { it.value.deadline <= now }
    // These SDK tasks must have a finite native execution window.
    if (timeoutMs <= 0) return@synchronized ""
    val token = UUID.randomUUID().toString()
    executions[token] = Execution(now + timeoutMs.toLong(), running)
    token
  }

  @JvmStatic
  fun current(token: String): Boolean {
    val execution = synchronized(lock) { executions[token] } ?: return false
    // RN owns its own task lock. Never call it while holding our registry lock:
    // finish callbacks can invalidate this execution from inside RN.
    val running = try {
      SystemClock.elapsedRealtime() < execution.deadline && execution.running.asBoolean
    } catch (_: Exception) { false }
    return synchronized(lock) {
      if (executions[token] !== execution) return@synchronized false
      if (!running || SystemClock.elapsedRealtime() >= execution.deadline) {
        executions.remove(token)
        return@synchronized false
      }
      true
    }
  }

  @JvmStatic
  fun end(token: String) { synchronized(lock) { executions.remove(token) } }
}
