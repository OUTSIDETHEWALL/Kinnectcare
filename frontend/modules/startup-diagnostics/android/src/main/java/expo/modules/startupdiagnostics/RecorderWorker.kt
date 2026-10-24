package expo.modules.startupdiagnostics

import java.util.PriorityQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicReferenceArray
import java.util.concurrent.atomic.AtomicLongArray
import java.util.concurrent.locks.LockSupport

/**
 * Bounded MPSC ring, one consumer. A producer makes at most eight CAS attempts.
 * An unpublished reservation can delay diagnostics, never another producer:
 * contention/full slots drop. No consumer lock or readiness wait exists.
 */
internal class RecorderQueue<T>(private val capacity: Int) {
  private val entries = AtomicReferenceArray<T?>(capacity)
  private val slots = AtomicLongArray(LongArray(capacity) { it.toLong() })
  private val enqueue = AtomicLong()
  private val dequeue = AtomicLong()
  val dropped = AtomicLong()
  val highWater = AtomicInteger()
  val size: Int get() = (enqueue.get() - dequeue.get()).toInt().coerceIn(0, capacity)
  fun offer(value: T): Boolean {
    repeat(8) {
      val position = enqueue.get()
      val index = (position % capacity).toInt()
      if (slots.get(index) != position) { dropped.incrementAndGet(); return false }
      if (enqueue.compareAndSet(position, position + 1)) {
        highWater.accumulateAndGet(size, ::maxOf)
        entries.set(index, value)
        slots.set(index, position + 1)
        return true
      }
    }
    dropped.incrementAndGet()
    return false
  }
  fun poll(): T? {
    val position = dequeue.get()
    val index = (position % capacity).toInt()
    if (slots.get(index) != position + 1) return null
    val value = entries.getAndSet(index, null)
    dequeue.set(position + 1)
    slots.set(index, position + capacity)
    return value
  }
  fun isNotEmpty(): Boolean = size != 0
}

/**
 * Scheduling without Handler/Looper. post only attempts bounded admission and
 * unparks an already existing thread. Only explicit lifecycle start creates it.
 */
internal class RecorderWorker(private val name: String, private val capacity: Int = 256) {
  private data class Work(val action: Runnable, val due: Long, val sequence: Long, val generation: Long, val initial: Boolean)
  private class Run(val generation: Long) {
    val stop = AtomicBoolean()
    @Volatile var finished = false
    @Volatile var thread: Thread? = null
  }
  private val queue = RecorderQueue<Work>(capacity)
  private val outstanding = AtomicInteger()
  private val sequence = AtomicLong()
  private val current = AtomicReference<Run?>()
  private val closed = AtomicBoolean()
  val failures = AtomicLong()
  val dropped = AtomicLong()
  val starts = AtomicInteger()

  fun post(action: Runnable): Boolean = postDelayed(action, 0)
  fun postDelayed(action: Runnable, delayMs: Long): Boolean = admit(action, delayMs, false)
  fun initialize(action: Runnable): Boolean = admit(action, 0, true)
  private fun admit(action: Runnable, delayMs: Long, initial: Boolean): Boolean {
    if (closed.get()) { dropped.incrementAndGet(); return false }
    if (outstanding.incrementAndGet() > capacity) {
      outstanding.decrementAndGet(); dropped.incrementAndGet(); return false
    }
    val accepted = queue.offer(Work(action,
      System.nanoTime() + maxOf(0L, delayMs) * 1000000L, sequence.incrementAndGet(),
      current.get()?.generation ?: 0L, initial))
    if (!accepted) { outstanding.decrementAndGet(); dropped.incrementAndGet() }
    // No start, lazy infrastructure, consumer lock, callback or JSON/disk here.
    current.get()?.thread?.let { LockSupport.unpark(it) }
    return accepted
  }

  /** Application bootstrap/test lifecycle only. Never called by recording paths. */
  fun start(): Boolean {
    val before = current.get()
    if (before != null && !before.finished) return false
    val run = Run(if (before == null) 0 else before.generation + 1)
    if (!current.compareAndSet(before, run)) return false
    closed.set(false)
    val thread = Thread({ execute(run) }, name)
    thread.isDaemon = true
    run.thread = thread
    return try { starts.incrementAndGet(); thread.start(); true }
    catch (_: Throwable) {
      failures.incrementAndGet(); closed.set(true); run.finished = true; false
    }
  }
  fun shutdown() {
    closed.set(true)
    current.get()?.let { it.stop.set(true); it.thread?.let { t -> LockSupport.unpark(t) } }
    // Never join. A blocked old consumer prevents recreation, not production.
  }
  private fun execute(run: Run) {
    val scheduled = PriorityQueue<Work>(compareBy<Work> { if (it.initial) 0 else 1 }.thenBy { it.due }.thenBy { it.sequence })
    try {
      try { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND) }
      catch (_: Throwable) { /* host harness/platform fallback; never on a producer */ }
      while (!run.stop.get()) {
        repeat(64) {
          queue.poll()?.let {
            if (it.generation == run.generation) scheduled.add(it)
            else { outstanding.decrementAndGet(); dropped.incrementAndGet() }
          }
        }
        val next = scheduled.peek()
        val wait = next?.let { if (it.initial) 0L else it.due - System.nanoTime() } ?: Long.MAX_VALUE
        if (next != null && wait <= 0) {
          scheduled.poll(); outstanding.decrementAndGet()
          try { next.action.run() } catch (_: Throwable) { failures.incrementAndGet() }
        } else {
          // Nonempty ingress can include an unpublished producer reservation.
          LockSupport.parkNanos(this, if (queue.isNotEmpty()) 1000000L else wait)
        }
      }
    } catch (_: Throwable) { failures.incrementAndGet() }
    finally {
      closed.set(true)
      // Old-generation delayed actions never run after recreation.
      outstanding.addAndGet(-scheduled.size)
      dropped.addAndGet(scheduled.size.toLong())
      // Leave ingress for the next generation to discard. Never spin on a
      // suspended gate owner, even during shutdown.
      run.finished = true
    }
  }
}
