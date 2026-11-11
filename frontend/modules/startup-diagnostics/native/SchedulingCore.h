#pragma once
// Diagnostic-only. No Java/JS calls, locks, allocation, IO, or thread startup.
#include <array>
#include <atomic>
#include <cstdint>
#include <ctime>
#include <cstring>

namespace kinnship78 {
enum Stage : int {
  Process = 1, Activity, Instance, Runtime, JsBound, Host, FrameControl,
  ScheduleEnter, ScheduleReturn, CreateEnter, Admitted, Deleted, Frame,
  Dispatch, Submit, RuntimeEnter, Callback, Progress, JsProgress, Context, Status
};
struct Event {
  int stage = 0, kind = 0, state = 0;
  uint64_t sequence = 0, runtime = 0, registration = 0, manager = 0;
  int64_t handle = -1, value = 0, elapsed = 0, uptime = 0;
  char request[33]{}, operation[33]{}, flight[33]{}, js[33]{};
};
inline int64_t clockNs(clockid_t clock) noexcept {
  timespec value{};
  return clock_gettime(clock, &value) == 0
      ? int64_t(value.tv_sec) * 1000000000 + value.tv_nsec : 0;
}
inline Event stamp(int stage) noexcept {
  Event e; e.stage = stage;
#ifdef CLOCK_BOOTTIME
  e.elapsed = clockNs(CLOCK_BOOTTIME);
#else
  e.elapsed = clockNs(CLOCK_MONOTONIC);
#endif
  e.uptime = clockNs(CLOCK_MONOTONIC); return e;
}
static_assert(std::atomic<uint64_t>::is_always_lock_free,
    "Build 78 requires lock-free 64-bit atomics on the delivered ABI");
static_assert(std::atomic<int>::is_always_lock_free, "lock-free counters required");

// Fixed MPSC ingress. Consumer is the existing recorder worker ONLY.
template <size_t N> struct Ring {
  struct Slot { std::atomic<uint64_t> sequence{0}; Event event{}; };
  std::array<Slot, N> slots{};
  std::atomic<uint64_t> write{0}, read{0}, drops{0};
  void initialize() noexcept {
    for (size_t i = 0; i < N; ++i) slots[i].sequence.store(i);
  }
  bool offer(const Event& e) noexcept {
    for (int attempt = 0; attempt < 8; ++attempt) {
      auto pos = write.load(std::memory_order_relaxed);
      auto& slot = slots[pos % N];
      if (slot.sequence.load(std::memory_order_acquire) != pos) break;
      if (write.compare_exchange_strong(pos, pos + 1)) {
        slot.event = e; slot.sequence.store(pos + 1, std::memory_order_release);
        return true;
      }
    }
    drops.fetch_add(1, std::memory_order_relaxed); return false;
  }
  bool poll(Event& e) noexcept {
    auto pos = read.load();
    auto& slot = slots[pos % N];
    if (slot.sequence.load(std::memory_order_acquire) != pos + 1) return false;
    e = slot.event; slot.sequence.store(pos + N, std::memory_order_release);
    read.store(pos + 1); return true;
  }
};
inline Ring<2048> ingress;
inline std::atomic<bool> ready{false};
inline std::atomic<uint64_t> sequences{0}, unavailable{0}, bindingLoss{0}, scratchLoss{0};
inline std::atomic<uint64_t> bindingContention{0};
inline std::atomic<int> initialization{0};
inline std::atomic<uint64_t> dueTimers{0}, lateTimers{0}, dispatchScratchOverflow{0}, maxLatenessMs{0}, summaryLoss{0};
// Called only by explicit RN instance lifecycle, never from emit/begin.
inline void initialize() noexcept {
  int expected = 0;
  if (initialization.compare_exchange_strong(expected, 1)) {
    ingress.initialize(); ready.store(true, std::memory_order_release);
    initialization.store(2);
  }
}
struct Local {
  std::array<Event, 4> scopes{};
  int depth = 0, overflow = 0, hold = 0, count = 0;
  std::array<Event, 32> scratch{};
  uint64_t runtime = 0, hostCause = 0, causeSerial = 0, lostScratch = 0;
  unsigned borrows = 0;
};
// Immutable-size, loader-initialized storage. The thread pointer is ONLY an
// already-existing OS thread identity, read by one hardware instruction; no
// diagnostic state resides in language/runtime TLS.
inline constexpr size_t localCapacity = 64;
#if defined(__cpp_constinit)
inline constinit std::array<std::atomic<uintptr_t>, localCapacity> localOwners{};
inline constinit std::array<Local, localCapacity> localStates{};
#else
inline std::array<std::atomic<uintptr_t>, localCapacity> localOwners{};
inline std::array<Local, localCapacity> localStates{};
#endif
static_assert(std::atomic<uintptr_t>::is_always_lock_free, "lock-free identity required");
inline std::atomic<bool> contextClosed{false};
inline std::atomic<uint64_t> contextLoss{0}, contextExhaustions{0};
inline uintptr_t threadIdentity() noexcept {
#if defined(__arm__)
  // Clang's ARM builtin otherwise calls __aeabi_read_tp. Read the Android/Linux
  // v7 thread register directly, avoiding even an out-of-line runtime helper.
  uintptr_t value;
  __asm__ volatile("mrc p15, 0, %0, c13, c0, 3" : "=r"(value));
  return value;
#else
  return reinterpret_cast<uintptr_t>(__builtin_thread_pointer());
#endif
}
struct LocalLease {
  Local* state = nullptr;
  size_t index = 0;
  explicit LocalLease(bool cleanup = false) noexcept {
    if (!cleanup && contextClosed.load(std::memory_order_acquire)) return;
    const auto key = threadIdentity();
    if (!key) { contextClosed.store(true); ++contextLoss; return; }
    const auto first = (key >> 12) % localCapacity;
    // Search BEFORE claiming: a freed earlier slot must not create a second
    // context for a thread that owns a later slot.
    for (size_t n = 0; n < localCapacity; ++n) {
      const auto i = (first + n) % localCapacity;
      if (localOwners[i].load(std::memory_order_acquire) == key) {
        index = i; state = &localStates[i]; ++state->borrows; return;
      }
    }
    if (contextClosed.load(std::memory_order_acquire)) return;
    for (size_t n = 0; n < localCapacity; ++n) {
      const auto i = (first + n) % localCapacity;
      uintptr_t empty = 0;
      if (localOwners[i].compare_exchange_strong(empty, key, std::memory_order_acq_rel)) {
        index = i; state = &localStates[i]; ++state->borrows; return;
      }
    }
    // A failed outer hold must NEVER permit a later inner event to acquire an
    // unheld context and publish under the vendor monitor. Close observation,
    // explicitly and permanently, rather than guess or backpressure callers.
    ++contextExhaustions; ++contextLoss;
    contextClosed.store(true, std::memory_order_release);
  }
  LocalLease(const LocalLease&) = delete;
  LocalLease& operator=(const LocalLease&) = delete;
  ~LocalLease() {
    if (!state) return;
    --state->borrows;
    if (!state->borrows && !state->depth && !state->overflow && !state->hold &&
        !state->count && !state->runtime && !state->hostCause) {
      localOwners[index].store(0, std::memory_order_release);
    }
  }
  explicit operator bool() const noexcept { return state != nullptr; }
};
inline uint64_t currentRuntime() noexcept {
  LocalLease lease; return lease ? lease.state->runtime : 0;
}
inline void publish(Event e) noexcept {
  if (!ready.load(std::memory_order_acquire)) { ++unavailable; return; }
  LocalLease lease;
  if (!lease || contextClosed.load()) { ++contextLoss; return; }
  auto& local = *lease.state;
  if (!e.runtime) e.runtime = local.runtime;
  if (local.hold) {
    if (local.count < int(local.scratch.size())) local.scratch[local.count++] = e;
    else ++local.lostScratch;
    return; // fixed owned scratch only; no ingress/writer under an outer RN lock
  }
  if (!e.sequence) e.sequence = ++sequences;
  ingress.offer(e);
}
inline void hold() noexcept {
  LocalLease lease; if (lease) ++lease.state->hold;
}
inline void release() noexcept {
  LocalLease lease(true);
  if (!lease) { ++contextLoss; return; }
  auto& local = *lease.state;
  if (local.hold <= 0) { ++scratchLoss; return; }
  if (--local.hold == 0) {
    for (int i = 0; i < local.count; ++i) {
      if (contextClosed.load()) { ++contextLoss; continue; }
      auto e = local.scratch[i]; e.sequence = ++sequences; ingress.offer(e);
    }
    scratchLoss.fetch_add(local.lostScratch); local.lostScratch = 0;
    local.count = 0;
  }
}
inline Event scope() noexcept {
  LocalLease lease;
  if (!lease) return Event{};
  auto& local = *lease.state;
  return local.depth && !local.overflow ? local.scopes[local.depth - 1] : Event{};
}
inline uint64_t begin(Event e) noexcept {
  if (!ready.load()) { ++unavailable; return 0; }
  LocalLease lease;
  if (!lease || contextClosed.load()) { ++contextLoss; return 0; }
  auto& local = *lease.state;
  if (local.depth == 4 || local.overflow) { ++local.overflow; ++bindingLoss; return uint64_t(-1); }
  e.stage = ScheduleEnter; e.registration = ++sequences; e.runtime = local.runtime;
  local.scopes[local.depth++] = e; publish(e); return e.registration;
}
inline void end(uint64_t registration, int64_t handle) noexcept {
  if (registration == 0) return;
  LocalLease lease(true);
  if (!lease) { ++contextLoss; return; }
  auto& local = *lease.state;
  if (local.overflow) { --local.overflow; return; }
  if (!local.depth || local.scopes[local.depth - 1].registration != registration) {
    ++bindingLoss; return;
  }
  auto e = local.scopes[--local.depth]; auto t = stamp(ScheduleReturn);
  e.stage = t.stage; e.elapsed = t.elapsed; e.uptime = t.uptime;
  e.handle = handle; e.state = handle >= 0 ? 1 : 0; publish(e);
}

// Slots are NEVER overwritten while pending. No guessed association on overflow.
// Access is bounded try-acquisition, not a spinlock: failure drops observation.
struct Binding { std::atomic<int> busy{0}; bool used = false; Event event{}; };
inline std::array<Binding, 128> bindings;
template <typename F> inline bool access(Binding& b, F fn) noexcept {
  int expected = 0;
  if (!b.busy.compare_exchange_strong(expected, 1, std::memory_order_acquire)) {
    ++bindingContention; return false;
  }
  fn(b); b.busy.store(0, std::memory_order_release); return true;
}
inline void selected(uint64_t runtime, int64_t handle) noexcept {
  auto e = scope(); if (!e.registration) return;
  e.runtime = runtime; e.handle = handle;
  for (auto& b : bindings) {
    bool stored = false;
    access(b, [&](Binding& slot) {
      if (!slot.used) { slot.event = e; slot.used = true; stored = true; }
    });
    if (stored) return;
  }
  ++bindingLoss;
}
inline Event find(uint64_t runtime, uint64_t manager, int64_t handle,
    uint64_t registration = 0, bool remove = false) noexcept {
  Event found{};
  for (auto& b : bindings) {
    access(b, [&](Binding& slot) {
      const auto& e = slot.event;
      if (slot.used && (runtime == 0 || runtime == e.runtime) &&
          (manager == 0 || manager == e.manager) &&
          (handle < 0 || handle == e.handle) &&
          (registration == 0 || registration == e.registration)) {
        found = e;
        if (remove) slot.used = false;
      }
    });
    if (found.registration) return found;
  }
  return found;
}
inline void timer(int stage, uint64_t runtime, uint64_t manager, int64_t handle,
    int64_t value = 0, int state = 0) noexcept {
  auto e = find(runtime, manager, handle);
  if (!e.registration) return;
  auto now = stamp(stage); e.stage = stage; e.elapsed = now.elapsed; e.uptime = now.uptime;
  e.value = value; e.state = state; if (manager) e.manager = manager;
  publish(e);
}
inline void admitted(uint64_t manager, int64_t handle, int64_t target, int state = 0) noexcept {
  auto s = scope(); if (!s.registration) return;
  Event captured{};
  for (auto& b : bindings) {
    access(b, [&](Binding& slot) {
      if (slot.used && slot.event.registration == s.registration) {
        slot.event.manager = manager; captured = slot.event;
      }
    });
  }
  if (!captured.registration) { ++bindingLoss; return; }
  timer(Admitted, captured.runtime, manager, handle, target, state);
}
inline void callback(uint64_t registration) noexcept {
  if (registration == 0 || registration == uint64_t(-1)) return;
  auto e = find(0, 0, -1, registration);
  if (!e.registration) { ++bindingLoss; return; }
  auto t = stamp(Callback); e.stage = t.stage; e.elapsed = t.elapsed; e.uptime = t.uptime;
  publish(e);
  find(e.runtime, e.manager, e.handle, registration, true);
}
inline void deleted(uint64_t manager, int64_t handle) noexcept {
  auto e = find(0, manager, handle);
  if (!e.registration) return;
  timer(Deleted, e.runtime, manager, handle);
  find(e.runtime, manager, handle, e.registration, true);
}
inline void invalidate(uint64_t runtime) noexcept {
  for (auto& b : bindings) {
    access(b, [&](Binding& slot) { if (slot.used && slot.event.runtime == runtime) slot.used = false; });
  }
}
inline std::atomic<uint64_t> runtimeIds{0};
// Passive fixed summaries; worker takes snapshots, no per-task/frame ingress.
struct Counter {
  std::atomic<uint64_t> count{0};
  std::atomic<int64_t> first{0}, last{0}, open{0};
};
struct RuntimeCounters {
  std::atomic<uint64_t> id{0};
  std::atomic<bool> jsBound{false};
  std::array<Counter, 16> values{};
};
// Slot zero is explicitly UNBOUND, never attributed to a known runtime.
inline std::array<RuntimeCounters, 5> runtimeCounters;
inline RuntimeCounters* runtimeSlot(uint64_t id) noexcept {
  if (!id) return &runtimeCounters[0];
  for (size_t i = 1; i < runtimeCounters.size(); ++i) {
    auto value = runtimeCounters[i].id.load();
    if (value == id) return &runtimeCounters[i];
    if (value == 0 && runtimeCounters[i].id.compare_exchange_strong(value, id)) return &runtimeCounters[i];
  }
  ++bindingLoss; return nullptr;
}
inline void managerDestroyed(uint64_t manager) noexcept {
  for (auto& b : bindings) {
    Event e{};
    access(b, [&](Binding& slot) {
      if (slot.used && slot.event.manager == manager) {
        e = slot.event; slot.used = false;
      }
    });
    if (e.registration) {
      auto t = stamp(Runtime);
      e.stage = Runtime; e.state = 2; e.elapsed = t.elapsed; e.uptime = t.uptime;
      publish(e);
    }
  }
}
inline void progress(int category, bool enter) noexcept {
  if (category < 0 || category >= 16 || !ready.load()) return;
  LocalLease lease;
  if (!lease || contextClosed.load()) return;
  auto slot = runtimeSlot(lease.state->runtime); if (!slot) return;
  auto now = stamp(Progress).elapsed; auto& c = slot->values[category];
  if (enter) {
    c.open.store(now); auto expected = int64_t(0); c.first.compare_exchange_strong(expected, now);
  } else { c.open.store(0); ++c.count; c.last.store(now); }
}
struct ProgressGuard {
  Counter* counter = nullptr;
  int64_t previous = 0;
  explicit ProgressGuard(int value) noexcept {
    if (!ready.load() || value < 0 || value >= 16) return;
    LocalLease lease;
    if (!lease || contextClosed.load()) return;
    auto slot = runtimeSlot(lease.state->runtime); if (!slot) return;
    counter = &slot->values[value];
    auto now = stamp(Progress).elapsed;
    previous = counter->open.exchange(now);
    int64_t expected = 0; counter->first.compare_exchange_strong(expected, now);
  }
  ~ProgressGuard() {
    if (!counter) return;
    ++counter->count; counter->last.store(stamp(Progress).elapsed); counter->open.store(previous);
  }
};
struct RuntimeScope {
  LocalLease lease;
  uint64_t previous = 0;
  explicit RuntimeScope(uint64_t id) noexcept {
    if (lease) { previous = lease.state->runtime; lease.state->runtime = id; }
  }
  ~RuntimeScope() { if (lease) lease.state->runtime = previous; }
};
} // namespace kinnship78
