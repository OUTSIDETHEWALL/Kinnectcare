package expo.modules.startupdiagnostics

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLongArray
import java.util.concurrent.atomic.AtomicReferenceArray

/**
 * Fixed diagnostic association table. At most 8 x 16 slot probes, never a lock.
 * A lost mutation invalidates its hash stripe, so a missed RN-ID collision or
 * removal cannot turn into a guessed association on a later call.
 */
internal class RecorderMap<K, V>(private val capacity: Int, private val onDrop: () -> Unit) {
  private data class Entry<K, V>(val key: K, val value: V, val epoch: Long)
  private val entries = AtomicReferenceArray<Entry<K, V>?>(capacity)
  private val epochs = AtomicLongArray(capacity)
  private val count = AtomicInteger()
  val size: Int get() = count.get().coerceIn(0, capacity)
  private fun base(key: K): Int {
    val h = key.hashCode()
    return ((h xor (h ushr 16)) and Int.MAX_VALUE) % capacity
  }
  operator fun get(key: K): V? {
    val base = base(key)
    val epoch = epochs.get(base)
    repeat(minOf(16, capacity)) {
      val entry = entries.get((base + it) % capacity)
      if (entry != null && entry.key == key)
        return if (entry.epoch == epoch && epochs.get(base) == epoch) entry.value else null
    }
    return null
  }
  fun containsKey(key: K): Boolean = get(key) != null
  operator fun set(key: K, value: V) { put(key, value) }
  fun put(key: K, value: V): Boolean = compute(key) { _, _ -> value } != null
  fun remove(key: K): V? = change(key, true) { _, _ -> null }
  fun putIfAbsent(key: K, value: V): V? = change(key, true) { _, old -> old ?: value }
  fun computeIfPresent(key: K, change: (K, V) -> V?): V? =
    compute(key) { k, value -> if (value == null) null else change(k, value) }
  fun computePrevious(key: K, transform: (K, V?) -> V?): V? = change(key, true, transform)
  fun compute(key: K, transform: (K, V?) -> V?): V? = change(key, false, transform)
  private fun change(key: K, returnOld: Boolean, transform: (K, V?) -> V?): V? {
    val base = base(key)
    repeat(8) {
      val epoch = epochs.get(base)
      var selected = -1
      var found: Entry<K, V>? = null
      var empty = -1
      for (offset in 0 until minOf(16, capacity)) {
        val index = (base + offset) % capacity
        val entry = entries.get(index)
        if (entry?.key == key) { selected = index; found = entry; break }
        if (empty < 0 && entry == null) empty = index
      }
      if (selected < 0) selected = empty
      if (selected < 0) {
        epochs.incrementAndGet(base); onDrop(); return null
      }
      val old = found?.takeIf { it.epoch == epoch }?.value
      val next = transform(key, old)
      val replacement: Entry<K, V>? = if (next == null) null else Entry(key, next, epoch)
      if (entries.compareAndSet(selected, found, replacement)) {
        if (found == null && replacement != null) count.incrementAndGet()
        if (found != null && replacement == null) count.decrementAndGet()
        return if (returnOld) old else next
      }
    }
    epochs.incrementAndGet(base); onDrop()
    return null
  }
}
