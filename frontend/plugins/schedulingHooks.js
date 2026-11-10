// Build 78: exact, fail-closed source transforms for a PINNED RN dependency.
const MARK = 'KinnshipScheduling78';
function once(s, needle, replacement) {
  if (s.split(needle).length !== 2) throw Error(`Build78 source drift: ${needle.slice(0, 90)}`);
  return s.replace(needle, replacement);
}
function wrapBody(s, signature, before, after) {
  const start = s.indexOf(signature);
  if (start < 0) throw Error('Build78 body missing: ' + signature);
  const open = s.indexOf('{', start);
  let depth = 1, end = open + 1;
  for (; end < s.length && depth; ++end) {
    if (s[end] === '{') depth++;
    else if (s[end] === '}') depth--;
  }
  if (depth) throw Error('Build78 unmatched body: ' + signature);
  return s.slice(0, open + 1) + before + s.slice(open + 1, end - 1) + after + s.slice(end - 1);
}
function fetch(s) {
  if (s.includes(MARK)) return s;
  // Apply AFTER the existing deep transform. Restrict to xhr.onload's success timer.
  const begin = s.indexOf('xhr.onload = function() {');
  const end = s.indexOf('xhr.onerror = function()', begin);
  if (begin < 0 || end < 0) throw Error('Build78 xhr.onload missing');
  let block = s.slice(begin, end);
  block = once(block, 'setTimeout(function() {',
    `// ${MARK}: real registration, distinct from Build77 scheduling intent.
      var kcRegistration = 0, kcTimerHandle = -1;
      try { kcRegistration = globalThis.__kinnshipTimerBegin?.(kcAsyncRequest, 1) || 0; } catch (_) {}
      try {
        kcTimerHandle = setTimeout(function() {
          try { globalThis.__kinnshipTimerCallback?.(kcRegistration); } catch (_) {}`);
  block = once(block, '}, 0)', `}, 0);
      } finally {
        try { globalThis.__kinnshipTimerEnd?.(kcRegistration, kcTimerHandle); } catch (_) {}
      }`);
  return s.slice(0, begin) + block + s.slice(end);
}
function timerHeader(s) {
  if (s.includes(MARK)) return s;
  s = '#include <cstdint>\n' + s;
  s = once(s, 'TimerHandle timerIndex_{1};', `// ${MARK}
  uint64_t kinnshipRuntime_{0};
  TimerHandle timerIndex_{1};`);
  s = once(s, 'void callTimer(TimerHandle handle);', `void callTimer(TimerHandle handle);
  uint64_t schedulingIdentity() const noexcept { return kinnshipRuntime_; }`);
  return s;
}
function timerCpp(s) {
  if (s.includes(MARK)) return s;
  s = '#include "SchedulingCore.h"\n// ' + MARK + '\n' + s;
  s = once(s, ': platformTimerRegistry_(std::move(platformTimerRegistry)) {}',
    `: platformTimerRegistry_(std::move(platformTimerRegistry)) {
  kinnshipRuntime_ = ++kinnship78::runtimeIds;
}`);
  s = once(s, 'platformTimerRegistry_->createTimer(timerID, delay);',
    `kinnship78::selected(kinnshipRuntime_, timerID);
  platformTimerRegistry_->createTimer(timerID, delay);`);
  s = once(s, 'void TimerManager::callTimer(TimerHandle timerHandle) {',
    `void TimerManager::callTimer(TimerHandle timerHandle) {
  kinnship78::timer(kinnship78::Submit, kinnshipRuntime_, 0, timerHandle);`);
  s = once(s, 'runtimeExecutor_([this, timerHandle](jsi::Runtime& runtime) {',
    `runtimeExecutor_([this, timerHandle](jsi::Runtime& runtime) {
    kinnship78::timer(kinnship78::RuntimeEnter, kinnshipRuntime_, 0, timerHandle,
        0, timers_.find(timerHandle) != timers_.end() ? 1 : 0);`);
  return s;
}
const probe = (stage, manager = 'schedulingIdentity', handle = '-1L', value = '0L', state = '0') =>
  `SchedulingProbe.event(${stage}, ${manager}, ${handle}, ${value}, ${state})`;
function javaTimer(s) {
  if (s.includes(MARK)) return s;
  s = once(s, 'package com.facebook.react.modules.core',
    `package com.facebook.react.modules.core\n// ${MARK}\nimport com.facebook.react.runtime.SchedulingProbe`);
  s = once(s, 'private val timerGuard = Any()',
    'public val schedulingIdentity: Long = SchedulingProbe.newManagerId()\n  private val timerGuard = Any()');
  // Native createTimer scope is synchronous on this inspected architecture.
  s = once(s, 'public open fun createTimer(timerId: Int, delay: Long, repeat: Boolean) {',
    `public open fun createTimer(timerId: Int, delay: Long, repeat: Boolean) {
    ${probe(10, undefined, 'timerId.toLong()', 'delay')}`);
  s = once(s, 'timerIdsToTimers.put(timerId, timer)\n    }',
    `timerIdsToTimers.put(timerId, timer)\n    }
    ${probe(11, undefined, 'timerId.toLong()', 'initialTargetTime',
      '(if (isPaused.get()) 1 else 0) + (if (isRunningTasks.get()) 2 else 0) + (if (frameCallbackPosted) 4 else 0)')}`);
  // Do not change deleteTimer's early return; absent timers never emit a deletion.
  s = once(s, 'timers.remove(timer)\n    }', `timers.remove(timer)\n    }
    ${probe(12, undefined, 'timerId.toLong()')}`);
  // State capture comes AFTER RN's own mutation. Native scratch defers admission
  // across the HeadlessJsTaskContext monitor (caller instrumentation below).
  for (const [name, state] of [
    ['onHostPause()', 1], ['onHostResume()', 2], ['onHostDestroy()', 3],
    ['onHeadlessJsTaskStart(taskId: Int)', 4], ['onHeadlessJsTaskFinish(taskId: Int)', 5],
    ['onInstanceDestroy()', 6],
  ]) {
    const needle = `${name} {`;
    s = once(s, needle, `${needle}
    ${probe(6, undefined, name.includes('taskId') ? 'taskId.toLong()' : '-1L', '0L',
      `${state} * 16 + (if (isPaused.get()) 1 else 0) + (if (isRunningTasks.get()) 2 else 0) + (if (frameCallbackPosted) 4 else 0)`)}`);
    s = wrapBody(s, needle, '\n    try {', `
    } finally {
      ${probe(6, undefined, name.includes('taskId') ? 'taskId.toLong()' : '-1L', '0L',
        `${state} * 16 + 128 + (if (isPaused.get()) 1 else 0) + (if (isRunningTasks.get()) 2 else 0) + (if (frameCallbackPosted) 4 else 0)`)}
    }
  `);
  }
  s = once(s, 'frameCallbackPosted = true', `frameCallbackPosted = true
      ${probe(7, undefined, '-1L', '0L', '1')}`);
  s = once(s, 'frameCallbackPosted = false\n    }', `frameCallbackPosted = false
      ${probe(7, undefined, '-1L', '0L', '2')}\n    }`);
  // No normal-frame stream. Counters only; first/release boundary is in dispatch.
  s = once(s, 'private inner class TimerFrameCallback : Choreographer.FrameCallback {',
    `private inner class TimerFrameCallback : Choreographer.FrameCallback {
    private var kcLastGate = -1
    private val kcSelected = LongArray(128)
    private var kcSelectedCount = 0`);
  const start = s.indexOf('private inner class TimerFrameCallback');
  const end = s.indexOf('private inner class IdleFrameCallback', start);
  let block = s.slice(start, end);
  block = once(block, 'override fun doFrame(frameTimeNanos: Long) {',
    `override fun doFrame(frameTimeNanos: Long) {
      val kcGate = (if (isPaused.get()) 1 else 0) + (if (isRunningTasks.get()) 2 else 0)
      if (kcGate != kcLastGate) {
        kcLastGate = kcGate
        ${probe(13, 'this@JavaTimerManager.schedulingIdentity', '-1L', 'frameTimeNanos', 'kcGate')}
      }
      SchedulingProbe.progress(0)
      kcSelectedCount = 0
      var kcDueCount = 0
      var kcLateCount = 0
      var kcLateMax = 0L`);
  // This is fixed scratch capture only while timerGuard is held.
  block = once(block, 'timersToCall?.pushInt(timer.timerId)', `timersToCall?.pushInt(timer.timerId)
          kcDueCount++
          val kcLateness = frameTimeMillis - timer.targetTime
          if (kcLateness >= 120000) kcLateCount++
          if (kcLateness > kcLateMax) kcLateMax = kcLateness
          if (kcSelectedCount < kcSelected.size) kcSelected[kcSelectedCount++] = timer.timerId.toLong()`);
  block = once(block, 'javaScriptTimerExecutor.callTimers(it)', `
        SchedulingProbe.event(18, this@JavaTimerManager.schedulingIdentity, 4L, kcDueCount.toLong(), kcLateCount)
        SchedulingProbe.event(18, this@JavaTimerManager.schedulingIdentity, 5L, kcLateMax, kcDueCount - kcSelectedCount)
        for (kcIndex in 0 until kcSelectedCount) {
          ${probe(14, 'this@JavaTimerManager.schedulingIdentity', 'kcSelected[kcIndex]', 'frameTimeNanos')}
        }
        javaScriptTimerExecutor.callTimers(it)`);
  return s.slice(0, start) + block + s.slice(end);
}
function instanceKt(s) {
  if (s.includes(MARK)) return s;
  s = once(s, 'javaScriptContextHolder = JavaScriptContextHolder(getJavaScriptContext())',
    `// ${MARK}: independent native lifecycle initialization, not a producer.
    SchedulingProbe.prepare()
    SchedulingProbe.event(3, System.identityHashCode(this).toLong(),
        javaTimerManager.schedulingIdentity, 0L, 1)
    javaScriptContextHolder = JavaScriptContextHolder(getJavaScriptContext())`);
  s = once(s, 'fun destroy() {', `fun destroy() {
    SchedulingProbe.event(3, System.identityHashCode(this).toLong(),
        javaTimerManager.schedulingIdentity, 0L, 2)`);
  s = once(s, 'javaScriptContextHolder.clear()', `javaScriptContextHolder.clear()
    SchedulingProbe.event(3, System.identityHashCode(this).toLong(), javaTimerManager.schedulingIdentity, 0L, 3)`);
  return s;
}
function schedulerCpp(s) {
  if (s.includes(MARK)) return s;
  s = '#include <react/runtime/SchedulingCore.h>\n// ' + MARK + '\n' + s;
  s = once(s, 'auto result = task.execute(runtime, didUserCallbackTimeout);',
    `kinnship78::ProgressGuard kcTask(1);
    auto result = task.execute(runtime, didUserCallbackTimeout);`);
  s = once(s, 'performingMicrotaskCheckpoint_ = true;', `performingMicrotaskCheckpoint_ = true;
  kinnship78::ProgressGuard kcMicrotask(2);`);
  return s;
}
function instanceCpp(s) {
  if (s.includes(MARK)) return s;
  s = '#include "SchedulingCore.h"\n// ' + MARK + '\n' + s;
  s = once(s, '[weakRuntime = std::weak_ptr(runtime_),',
    '[kcRuntime = timerManager_->schedulingIdentity(), weakRuntime = std::weak_ptr(runtime_),');
  s = once(s, 'jsThread->runOnQueue([jsErrorHandler,',
    'jsThread->runOnQueue([kcRuntime, jsErrorHandler,');
  s = once(s, 'TraceSection s("ReactInstance::_runtimeExecutor[Callback]");',
    `kinnship78::RuntimeScope kcRuntimeScope(kcRuntime);
            kinnship78::ProgressGuard kcExecutor(3);
            TraceSection s("ReactInstance::_runtimeExecutor[Callback]");`);
  s = once(s, 'TraceSection s("ReactInstance::initializeRuntime");',
    `auto kcReady = kinnship78::stamp(kinnship78::Runtime);
    kcReady.runtime = timerManager_->schedulingIdentity(); kcReady.state = 1;
    kinnship78::publish(kcReady);
    TraceSection s("ReactInstance::initializeRuntime");`);
  return s;
}
const javaProbe = `package com.facebook.react.runtime
// ${MARK}: native store is linked into the RN library; no producer loads it.
public object SchedulingProbe {
  @Volatile private var active = false
  private val ids = java.util.concurrent.atomic.AtomicLong()
  @JvmStatic public fun newManagerId(): Long = ids.incrementAndGet()
  @JvmStatic public external fun initializeNative(): Unit
  @JvmStatic public external fun eventNative(stage: Int, manager: Long, handle: Long, value: Long, state: Int): Unit
  @JvmStatic public external fun holdNative(): Unit
  @JvmStatic public external fun releaseNative(): Unit
  @JvmStatic public fun prepare(): Unit {
    try {
      initializeNative()
      eventNative(0, 0, 0, 0, 0)
      holdNative()
      releaseNative()
      active = true
      Class.forName("expo.modules.startupdiagnostics.SchedulingBridge")
        .getMethod("activate").invoke(null)
    } catch (_: Throwable) { active = false }
  }
  @JvmStatic public fun event(stage: Int, manager: Long, handle: Long, value: Long, state: Int): Unit {
    if (active) try { eventNative(stage, manager, handle, value, state) } catch (_: Throwable) {}
  }
  @JvmStatic public fun progress(category: Int): Unit {
    // Frame counters are aggregated natively, not one ring entry per frame.
    if (active) try { eventNative(18, 0, category.toLong(), 0, 0) } catch (_: Throwable) {}
  }
  @JvmStatic public fun hold(): Unit { if (active) try { holdNative() } catch (_: Throwable) {} }
  @JvmStatic public fun release(): Unit { if (active) try { releaseNative() } catch (_: Throwable) {} }
}
`;
module.exports = { MARK, once, fetch, timerHeader, timerCpp, javaTimer, instanceKt, schedulerCpp, instanceCpp, javaProbe };
