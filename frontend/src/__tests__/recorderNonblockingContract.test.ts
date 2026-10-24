import fs from 'fs';
import path from 'path';
const native = path.resolve(__dirname, '../../modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics');
const source = (file: string) => fs.readFileSync(path.join(native, file), 'utf8');

describe('async recorder producer safety', () => {
  test.each(['DeepAsyncTrace.kt', 'RequestOrigins.kt', 'EvidenceTrace.kt'])('%s has no lazy/looper/locking queue/readiness waits', file => {
    const text = source(file);
    expect(text).not.toMatch(/HandlerThread|\.looper|getLooper|by lazy|synchronized\s*\(|ArrayBlockingQueue|ConcurrentHashMap|CompletableFuture|randomUUID/);
    expect(text).toContain('RecorderWorker(');
    expect(text).toContain('RecorderQueue<');
  });
  test('admission never creates or waits for infrastructure', () => {
    const text = source('RecorderWorker.kt');
    const admission = text.slice(text.indexOf('fun post(action'), text.indexOf('/** Application bootstrap'));
    expect(admission).toContain('queue.offer');
    expect(admission).toContain('LockSupport.unpark');
    expect(admission).not.toMatch(/\.start\(|\.join\(|\.await\(|\.getLooper\(|\.lock\(|parkNanos|Thread\(/);
    const queue = text.slice(text.indexOf('fun offer(value'), text.indexOf('fun poll()'));
    expect(queue).toContain('repeat(8)');
    expect(queue).toContain('compareAndSet');
    expect(queue).not.toMatch(/\.lock\(|\.await\(|\.put\(/);
    expect(source('RecorderMap.kt')).toContain('AtomicReferenceArray');
    expect(source('RecorderMap.kt')).not.toMatch(/gate\.lock\(|synchronized/);
  });
  test('bootstrap is a separate Application lifecycle operation', () => {
    const plugin = require('../../plugins/withAndroidStartupRecorder');
    const base = 'class MainApplication { override fun onCreate() { super.onCreate() } }';
    const once = plugin.injectMainApplication(base);
    expect(once).toContain('RecorderBootstrap.start(this)');
    expect(plugin.injectMainApplication(once)).toBe(once);
    expect(source('StartupDiagnosticsModule.kt')).not.toContain('RecorderBootstrap');
    for (const name of ['DeepAsyncTrace.kt', 'RequestOrigins.kt', 'EvidenceTrace.kt'])
      expect(source(name)).not.toContain('RecorderBootstrap');
  });
  test('Build 75 stays immutable and Build 76 has its own profile', () => {
    const eas = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../eas.json'), 'utf8'));
    expect(eas.build.diagnostic75.env.KINNSHIP_DIAGNOSTIC_BUILD).toBe('75');
    expect(eas.build.diagnostic75.channel).toBe('diagnostic75');
    expect(eas.build.diagnostic76.env.KINNSHIP_DIAGNOSTIC_BUILD).toBe('76');
    expect(eas.build.diagnostic76.channel).toBe('diagnostic76');
  });
});
