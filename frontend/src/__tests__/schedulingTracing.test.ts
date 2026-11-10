import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { bindSchedulingObserver, rememberSchedulingContext, timerBegin, timerEnd, timerCallback } from '../schedulingTrace';
const h = require('../../plugins/schedulingHooks');
const deep = require('../../plugins/deepAsyncHooks');
const plugin = require('../../plugins/withSchedulingTracing');
const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('Build78 passive scheduling correlation', () => {
  it('uses statically initialized bounded ownership, never producer runtime TLS or lazy state', () => {
    const core = read('modules/startup-diagnostics/native/SchedulingCore.h');
    expect(core).not.toMatch(/\bthread_local\b|__emutls|pthread_getspecific|pthread_setspecific/);
    expect(core).toContain('constinit');
    expect(core).toContain('contextClosed.store(true');
    expect(read('modules/startup-diagnostics/native/SchedulingJni.h')).toContain('"contextExhaustions');
  });
  it('installs the Application hook before or after the recorder plugin, exactly once', () => {
    const base = 'override fun onCreate() { super.onCreate() }';
    for (const source of [base, base.replace('super.onCreate()', 'super.onCreate(); expo.modules.startupdiagnostics.RecorderBootstrap.start(this)')]) {
      const result = plugin.injectApplication(source);
      expect(result).toContain('SchedulingTrace.install(this)');
      expect(plugin.injectApplication(result)).toBe(result);
    }
  });
  it('binds selected requests with immutable helper/flight/runtime identity', () => {
    const begin = jest.fn(() => 42), end = jest.fn(), run = jest.fn();
    bindSchedulingObserver({ schedulingBegin: begin, schedulingEnd: end, schedulingCallback: run }, 'f'.repeat(32));
    const context = { operation: 'a'.repeat(32), flight: 'b'.repeat(32), asyncRequest: 'c'.repeat(32) };
    rememberSchedulingContext(context, 'helper_entered');
    expect(timerBegin(context.asyncRequest, 2)).toBe(42);
    expect(begin).toHaveBeenCalledWith(context.asyncRequest, context.operation, context.flight, 'f'.repeat(32), 2);
    timerEnd(42, 7); timerCallback(42);
    expect(end).toHaveBeenCalledWith(42, 7); expect(run).toHaveBeenCalledWith(42);
    rememberSchedulingContext(context, 'helper_exited');
    expect(timerBegin(context.asyncRequest, 1)).toBe(0);
  });
  it('observer failure and unavailable native module cannot prevent the real timer call', () => {
    bindSchedulingObserver({ schedulingBegin: () => { throw Error('observer'); } }, '');
    expect(() => timerEnd(1, 2)).not.toThrow();
    expect(() => timerCallback(1)).not.toThrow();
    expect(timerBegin(undefined, 1)).toBe(0);
    bindSchedulingObserver(null, '');
    expect(timerBegin('d'.repeat(32), 1)).toBe(0);
  });
  it('closes an overflow scope without treating it as a real callback', () => {
    const end = jest.fn(), run = jest.fn();
    bindSchedulingObserver({ schedulingEnd: end, schedulingCallback: run }, '');
    timerEnd(-1, 2); timerCallback(-1);
    expect(end).toHaveBeenCalledWith(-1, 2); expect(run).not.toHaveBeenCalled();
  });
  it.each(['dist/fetch.umd.js', 'fetch.js'])('surrounds the real %s fetch registration and preserves old intent semantics', file => {
    const source = deep.fetch(read('node_modules/whatwg-fetch/' + file));
    const patched = h.fetch(source);
    expect(h.fetch(patched)).toBe(patched);
    expect(patched.indexOf("'fetch_callback_scheduled'")).toBeLessThan(patched.indexOf('__kinnshipTimerBegin'));
    expect(patched.indexOf('__kinnshipTimerBegin')).toBeLessThan(patched.indexOf('kcTimerHandle = setTimeout'));
    expect(patched.indexOf('__kinnshipTimerCallback')).toBeLessThan(patched.indexOf("'fetch_callback_executed'"));
    expect(patched.indexOf('kcTimerHandle = setTimeout')).toBeLessThan(patched.indexOf('__kinnshipTimerEnd'));
    expect((patched.match(/setTimeout\(function/g) ?? []).length).toBe((source.match(/setTimeout\(function/g) ?? []).length);
    const js = file.endsWith('.umd.js') ? patched : require('typescript').transpileModule(patched, {
      compilerOptions: { module: require('typescript').ModuleKind.CommonJS },
    }).outputText;
    expect(() => new vm.Script(js)).not.toThrow();
  });
  it.each(plugin.transforms.map(([p, transform]: [string, Function]) => [p, transform]))(
    'applies idempotently to pinned dependency %s', (file: string, transform: Function) => {
      const source = read('node_modules/react-native/' + file);
      const patched = transform(source);
      expect(transform(patched)).toBe(patched);
      expect(patched).toContain(h.MARK);
    });
  it('fails explicitly on dependency drift', () => {
    expect(() => h.javaTimer('wrong source')).toThrow(/drift/);
    expect(() => h.timerCpp('wrong source')).toThrow(/drift/);
    expect(() => h.fetch('wrong source')).toThrow(/missing/);
  });
  it('uses the native C++ source build path, not the unmodified published AAR', () => {
    expect(plugin.settings).toContain("includeBuild('../node_modules/react-native')");
    expect(plugin.settings).toContain('module("com.facebook.react:react-native")');
    expect(plugin.settings).toContain('substitute(module("com.facebook.react:react-android"))');
    expect(plugin.settings).not.toContain('hermes-android');
    expect(read('app.config.js')).toContain('./plugins/withSchedulingTracing');
  });
  it('leaves the original HTTP, abort deadline, cancellation and task fence intact', () => {
    const recovery = read('src/androidTrackingRecovery.ts');
    expect(recovery).toContain('}, 8000)');
    expect(recovery).toContain('clearTimeout(timeout)');
    expect(recovery).toContain('controller.abort()');
    expect(read('plugins/headlessTaskLifetimeHooks.js')).toContain('KinnshipHeadlessTaskLifetime');
    expect(read('src/diagnosticsFull.tsx')).toContain('schedulingEvidence: readSchedulingTrace()');
  });
  it('native producers have no IO/worker/thread initialization and use bounded admission', () => {
    const core = read('modules/startup-diagnostics/native/SchedulingCore.h');
    expect(core).toContain('attempt < 8');
    for (const banned of ['std::mutex', 'new ', 'sleep(', 'join(', 'JNIEnv', 'ofstream', 'malloc(', 'while (']) {
      expect(core).not.toContain(banned);
    }
    const js = read('src/schedulingTrace.ts');
    expect(js).not.toMatch(/setInterval\(|setTimeout\(|queueMicrotask\(|fetch\(|JSON.stringify/);
    const bridge = read('modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/SchedulingBridge.kt');
    expect(bridge).not.toMatch(/commit\(|synchronized|Thread\(|Handler|startWorker|initialize\(/);
  });
});
