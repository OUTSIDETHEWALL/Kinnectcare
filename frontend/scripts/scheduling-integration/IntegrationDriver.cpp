// Test-only JNI driver. Actual producer/drain implementations are included intact.
// Advance both monotonic clocks for the 46-minute simulation, never real sleep.
#include <ctime>
#include <atomic>
#include <thread>
#include <vector>
static std::atomic<int64_t> fixtureOffset{0};
static int fixtureClock(clockid_t id, timespec* value) {
  auto result = ::clock_gettime(id, value);
  value->tv_sec += fixtureOffset.load() / 1000000000LL;
  return result;
}
#define clock_gettime fixtureClock
#include "../../modules/startup-diagnostics/native/SchedulingJni.h"
#undef clock_gettime
extern "C" {
JNIEXPORT void JNICALL Java_IntegrationDriver_runtime(JNIEnv*, jclass, jlong id) {
  kinnship78::LocalLease lease;
  if (lease) lease.state->runtime = id;
}
JNIEXPORT void JNICALL Java_IntegrationDriver_selected(JNIEnv*, jclass, jlong handle) {
  kinnship78::selected(kinnship78::currentRuntime(), handle);
}
JNIEXPORT void JNICALL Java_IntegrationDriver_timer(JNIEnv*, jclass, jint stage, jlong handle) {
  kinnship78::timer(stage, kinnship78::currentRuntime(), 0, handle, 0, 1);
}
JNIEXPORT void JNICALL Java_IntegrationDriver_advance(JNIEnv*, jclass, jlong nanos) {
  fixtureOffset.store(nanos);
}
JNIEXPORT void JNICALL Java_IntegrationDriver_firstExecutor(JNIEnv*, jclass) {
  kinnship78::RuntimeScope scope(7);
  kinnship78::ProgressGuard guard(3);
}
JNIEXPORT void JNICALL Java_IntegrationDriver_exhaust(JNIEnv*, jclass) {
  std::atomic<int> entered{0}; std::atomic<bool> leave{false};
  std::vector<std::thread> threads;
  for (size_t i=0;i<kinnship78::localCapacity;++i) threads.emplace_back([&] {
    kinnship78::hold(); ++entered;
    while(!leave.load())std::this_thread::yield();
    kinnship78::release();
  });
  while(entered.load()!=int(kinnship78::localCapacity))std::this_thread::yield();
  kinnship78::hold(); // the extra caller has no slot: globally counted failure
  leave.store(true); for(auto& thread:threads)thread.join();
}
}
