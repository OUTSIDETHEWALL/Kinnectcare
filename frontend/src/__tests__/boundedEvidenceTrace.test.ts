import fs from 'fs';
import path from 'path';

let mockEvidence: any = null;
jest.mock('expo', () => ({ requireOptionalNativeModule: () => mockEvidence }));
import { readEvidenceTrace, recordEvidence, startupTraceId } from '../evidenceTrace';

const plugin = require('../../plugins/withAndroidEvidenceTracing');
const startupPlugin = require('../../plugins/withAndroidStartupRecorder');
const root = path.resolve(__dirname, '../..');
const native = 'modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics';
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('optional bounded evidence extension', () => {
  beforeEach(() => { mockEvidence = null; });
  it('does not arm native correlation on Build 70, web or an absent bridge', () => {
    expect(startupTraceId()).toBeNull();
    expect(readEvidenceTrace()).toEqual({ available: false, reason: 'native_evidence_extension_required' });
    expect(() => recordEvidence('gps', 'js_wake_received', null)).not.toThrow();
  });
  it('contains unavailable/version/read/record failures', () => {
    mockEvidence = { evidenceVersion: () => { throw new Error('unavailable'); } };
    expect(startupTraceId()).toBeNull();
    mockEvidence = {
      evidenceVersion: () => 1, evidenceRecord: () => { throw new Error('disk'); },
      evidenceRead: () => 'invalid',
    };
    expect(() => recordEvidence('http', 'js_adapter_started', 'a'.repeat(32))).not.toThrow();
    expect(readEvidenceTrace()).toEqual({ available: false, reason: 'evidence_read_failed' });
  });
  it('uses opaque IDs and the same optional recorder on the supported binary', () => {
    const record = jest.fn();
    mockEvidence = { evidenceVersion: () => 1, evidenceRecord: record, evidenceRead: () => '{"available":true}' };
    const id = startupTraceId();
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    recordEvidence('http', 'js_adapter_started', id);
    expect(record).toHaveBeenCalledWith('http', 'js_adapter_started', id, '{}');
    expect(readEvidenceTrace()).toEqual({ available: true });
  });
});

describe('native evidence source contracts (not native compilation)', () => {
  it.each([
    ['react-native-background-geolocation', 'rnbackgroundgeolocation', 'HeadlessTask.java', 'headless'],
    ['react-native-background-geolocation', 'rnbackgroundgeolocation', 'HeadlessTaskManager.java', 'manager'],
    ['react-native-background-geolocation', 'rnbackgroundgeolocation', 'RNBackgroundGeolocationModule.java', 'locationModule'],
    ['react-native-background-fetch', 'rnbackgroundfetch', 'HeadlessTask.java', 'fetchHeadless'],
  ])('patches installed %s %s/%s idempotently without changing original lines', (pkg, dir, file, transform) => {
    const source = read(`node_modules/${pkg}/android/src/main/java/com/transistorsoft/${dir}/${file}`);
    const result = plugin[transform](source);
    expect(result).toContain('KinnshipBoundedEvidence');
    expect(plugin[transform](result)).toBe(result);
    // Every original nonempty line remains in its original order. Hooks only insert.
    let after = 0;
    for (const line of source.split('\n').filter((value: string) => value.trim())) {
      const at = result.indexOf(line, after);
      expect(at).toBeGreaterThanOrEqual(after);
      after = at + line.length;
    }
  });
  it('fails explicitly on source drift instead of claiming hooks were applied', () => {
    expect(() => plugin.headless('class Changed {}')).toThrow('source drift');
    expect(() => plugin.locationModule('class Changed {}')).toThrow('source drift');
  });
  it('upgrades the existing generated Application once and installs before RN initialization', () => {
    const old = `class App {
      override fun onCreate() {
        // KinnshipStartupDiagnostics
        expo.modules.startupdiagnostics.StartupDiagnosticsRecorder.record(this, "native_application_on_create_started", null)
        super.onCreate()
      }
    }`;
    const result = startupPlugin.injectMainApplication(old);
    expect(result.indexOf('NativeHttpEvidence.install')).toBeLessThan(result.indexOf('super.onCreate'));
    expect(startupPlugin.injectMainApplication(result)).toBe(result);
  });
  it('retains the hourly gate, expiry and backoff exactly', () => {
    const source = read(`${native}/TrackingReliability.kt`);
    expect(source).toContain('elapsed - claimed < 60000');
    expect(source).toContain('next - now <= 30 * 60000');
    expect(source).toContain('if (recentMoving) 10 * 60000 else 60 * 60000');
    for (const reason of ['revoked', 'generation_mismatch', 'owner_mismatch', 'mutation_pending',
      'shutdown_pending', 'lease_active', 'backoff', 'capture_recent']) {
      expect(source).toContain(`decision(false, "${reason}")`);
    }
  });
  it('keeps evidence outside authority storage and off the producer disk path', () => {
    const source = read(`${native}/EvidenceTrace.kt`);
    expect(read(`${native}/EvidenceStore.kt`)).toContain('kinnship_bounded_evidence_v2');
    expect(source).not.toContain('kinnship_tracking_reliability_v1');
    expect(source).toContain('writer.postDelayed({ flush() }, 1000)');
    expect(source).toContain('tail(http, 512)');
    expect(source).toContain('tail(gps, 2048)');
    expect(source).toContain('keys.dropLast(48)');
    expect(source).toContain('value is Number || value is Boolean');
    expect(source).not.toContain('"owner"');
    expect(source).not.toContain('"latitude"');
    expect(source).not.toContain('"token"');
    const producer = source.slice(source.indexOf('@JvmStatic fun record('), source.indexOf('private fun scheduleDrain'));
    expect(producer).toContain('pending.offer');
    expect(producer).not.toContain('JSONObject');
    expect(producer).not.toContain('synchronized(lock)');
    expect(source).toContain('RecorderQueue<Pending>(1024)');
    expect(source).toContain('counters.length() < 256');
  });
  it('observes the existing client without modifying transport policy', () => {
    const source = read(`${native}/NativeHttpEvidence.kt`);
    for (const forbidden of ['.connectTimeout(', '.readTimeout(', '.dispatcher(', '.connectionPool(',
      '.retryOnConnectionFailure(', '.dns(', '.protocols(', '.cache(', '.cancel(']) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('chain.proceed(chain.request())');
    expect(source).toContain('val original = existing.eventListenerFactory');
    expect(source).toContain('declined_existing_custom_builder');
    for (const callback of ['proxySelectStart', 'proxySelectEnd', 'cacheHit', 'cacheMiss',
      'cacheConditionalHit', 'satisfactionFailure']) expect(source).toContain(`delegate.${callback}(`);
  });
  it('exports the trace through Full Diagnostics', () => {
    expect(read('src/diagnosticsFull.tsx')).toContain('boundedNativeEvidence: readEvidenceTrace()');
  });
});
