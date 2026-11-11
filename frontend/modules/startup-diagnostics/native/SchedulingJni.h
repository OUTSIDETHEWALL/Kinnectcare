#pragma once
#include <jni.h>
#include <sstream>
#include "SchedulingCore.h"

// All string decoding is bounded to 32 UTF-16 units; no GetStringUTFChars/pinning.
inline void kc78Id(JNIEnv* env, jstring input, char (&out)[33]) noexcept {
  if (!input || env->GetStringLength(input) != 32) return;
  jchar value[32]; env->GetStringRegion(input, 0, 32, value);
  for (int i = 0; i < 32; ++i) {
    if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) {
      out[0] = 0; return;
    }
    out[i] = char(value[i]);
  }
}
extern "C" {
JNIEXPORT void JNICALL Java_com_facebook_react_runtime_SchedulingProbe_initializeNative(JNIEnv*, jclass) {
  kinnship78::initialize();
}
JNIEXPORT void JNICALL Java_com_facebook_react_runtime_SchedulingProbe_holdNative(JNIEnv*, jclass) {
  kinnship78::hold();
}
JNIEXPORT void JNICALL Java_com_facebook_react_runtime_SchedulingProbe_releaseNative(JNIEnv*, jclass) {
  kinnship78::release();
}
JNIEXPORT void JNICALL Java_com_facebook_react_runtime_SchedulingProbe_eventNative(
    JNIEnv*, jclass, jint stage, jlong manager, jlong handle, jlong value, jint state) {
  using namespace kinnship78;
  if (stage == 0) return; // lifecycle-only JNI linkage warmup; no observation
  if (stage == Progress) {
    if (handle == 4) { dueTimers.fetch_add(value); lateTimers.fetch_add(state); return; }
    if (handle == 5) {
      dispatchScratchOverflow.fetch_add(state);
      auto before = maxLatenessMs.load();
      for (int attempt = 0; attempt < 8 && uint64_t(value) > before; ++attempt) {
        if (maxLatenessMs.compare_exchange_strong(before, uint64_t(value))) return;
      }
      if (uint64_t(value) > before) ++summaryLoss;
      return;
    }
    progress(int(handle), true); progress(int(handle), false); return;
  }
  if (stage == Admitted) { admitted(manager, handle, value, state); return; }
  if (stage == Deleted) { deleted(manager, handle); return; }
  if (stage == Dispatch) { timer(Dispatch, 0, manager, handle, value, state); return; }
  if (stage == CreateEnter) {
    auto e = scope(); if (!e.registration) return;
    auto t = stamp(stage); e.stage = stage; e.elapsed = t.elapsed; e.uptime = t.uptime;
    e.manager = manager; e.handle = handle; publish(e); return;
  }
  auto e = stamp(stage); e.manager = manager; e.handle = handle; e.value = value; e.state = state;
  LocalLease lease;
  if (!lease || contextClosed.load()) { ++contextLoss; return; }
  auto& local = *lease.state;
  if (stage == Host && state < 128) {
    // Per-slot monotonic serial plus slot index remains unique across reuse.
    e.value = (++local.causeSerial * localCapacity) + lease.index;
    local.hostCause = e.value;
  }
  if (stage == FrameControl) e.value = local.hostCause; // exact current listener scope
  publish(e);
  if (stage == Host && state >= 128) local.hostCause = 0;
  if (stage == Instance && state == 3) managerDestroyed(handle);
}
JNIEXPORT jlong JNICALL Java_expo_modules_startupdiagnostics_SchedulingBridge_beginNative(
    JNIEnv* env, jclass, jstring request, jstring operation, jstring flight, jstring js, jint kind) {
  auto e = kinnship78::stamp(kinnship78::ScheduleEnter);
  kc78Id(env, request, e.request); kc78Id(env, operation, e.operation);
  kc78Id(env, flight, e.flight); kc78Id(env, js, e.js);
  e.kind = kind & 255; e.state = (kind >> 8) & 1;
  if (!e.request[0]) return 0;
  auto slot = kinnship78::runtimeSlot(kinnship78::currentRuntime());
  if (slot && !slot->jsBound.exchange(true)) {
    auto bound = e; bound.stage = kinnship78::JsBound; kinnship78::publish(bound);
  }
  return kinnship78::begin(e);
}
JNIEXPORT void JNICALL Java_expo_modules_startupdiagnostics_SchedulingBridge_endNative(
    JNIEnv*, jclass, jlong registration, jlong handle) {
  kinnship78::end(registration, handle);
}
JNIEXPORT void JNICALL Java_expo_modules_startupdiagnostics_SchedulingBridge_callbackNative(
    JNIEnv*, jclass, jlong registration) { kinnship78::callback(registration); }
JNIEXPORT void JNICALL Java_expo_modules_startupdiagnostics_SchedulingBridge_progressNative(
    JNIEnv*, jclass, jint category) { kinnship78::progress(category, true); kinnship78::progress(category, false); }

// Worker ONLY. This function is intentionally allocating/serializing.
JNIEXPORT jstring JNICALL Java_expo_modules_startupdiagnostics_SchedulingBridge_drainNative(JNIEnv* env, jclass) {
  using namespace kinnship78;
  std::ostringstream out;
  out << "{\"schema\":78,\"ready\":" << (ready.load() ? "true" : "false")
      << ",\"drops\":" << ingress.drops.load() << ",\"unavailable\":" << unavailable.load()
      << ",\"bindingLoss\":" << bindingLoss.load() << ",\"scratchLoss\":" << scratchLoss.load()
      << ",\"bindingContention\":" << bindingContention.load()
      << ",\"dueTimers\":" << dueTimers.load() << ",\"lateTimers\":" << lateTimers.load()
      << ",\"maxLatenessMs\":" << maxLatenessMs.load() << ",\"summaryLoss\":" << summaryLoss.load()
      << ",\"dispatchScratchOverflow\":" << dispatchScratchOverflow.load()
      << ",\"contextCapacity\":" << localCapacity
      << ",\"contextClosed\":" << (contextClosed.load() ? "true" : "false")
      << ",\"contextLoss\":" << contextLoss.load()
      << ",\"contextExhaustions\":" << contextExhaustions.load()
      << ",\"events\":[";
  Event e; bool first = true;
  for (int i = 0; i < 2048 && ingress.poll(e); ++i) {
    if (!first) out << ','; first = false;
    out << "{\"stage\":" << e.stage << ",\"kind\":" << e.kind << ",\"state\":" << e.state
        << ",\"sequence\":" << e.sequence << ",\"runtime\":" << e.runtime
        << ",\"registration\":" << e.registration << ",\"manager\":" << e.manager
        << ",\"handle\":" << e.handle << ",\"value\":" << e.value
        << ",\"elapsedNs\":" << e.elapsed << ",\"uptimeNs\":" << e.uptime
        << ",\"request\":\"" << e.request << "\",\"operation\":\"" << e.operation
        << "\",\"flight\":\"" << e.flight << "\",\"js\":\"" << e.js << "\"}";
  }
  out << "],\"counters\":[";
  bool firstCounter = true;
  for (size_t r = 0; r < runtimeCounters.size(); ++r) {
    for (int i = 0; i < 16; ++i) {
      auto& counter = runtimeCounters[r].values[i];
      if (!counter.count.load() && !counter.open.load()) continue;
      if (!firstCounter) out << ','; firstCounter = false;
      out << "{\"runtime\":" << runtimeCounters[r].id.load() << ",\"category\":" << i
          << ",\"count\":" << counter.count.load()
          << ",\"first\":" << counter.first.load() << ",\"last\":" << counter.last.load()
          << ",\"open\":" << counter.open.load() << '}';
    }
  }
  out << "]}";
  return env->NewStringUTF(out.str().c_str());
}
}
