import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const root = path.resolve(__dirname, '../..');
const plugin = require('../../plugins/withSchedulingTracing');
const hooks = require('../../plugins/schedulingHooks');
const script = path.join(root, 'scripts/verify-scheduling-compiled.js');
let fixture: string;
function write(name: string, content: string) {
  const file = path.join(fixture, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function run(...args: string[]) {
  return spawnSync(process.execPath, [script, fixture, ...args], { encoding: 'utf8' });
}
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduling-compile-gate-'));
  write('node_modules/react-native/package.json', '{"version":"0.81.5"}');
  for (const [file, transform] of plugin.transforms) {
    write('node_modules/react-native/' + file,
      transform(fs.readFileSync(path.join(root, 'node_modules/react-native', file), 'utf8')));
  }
  for (const file of ['SchedulingCore.h', 'SchedulingJni.h']) {
    write('node_modules/react-native/ReactCommon/react/runtime/' + file,
      fs.readFileSync(path.join(root, 'modules/startup-diagnostics/native', file), 'utf8'));
    write('modules/startup-diagnostics/native/' + file,
      fs.readFileSync(path.join(root, 'modules/startup-diagnostics/native', file), 'utf8'));
  }
  for (const file of ['schedulingHooks.js', 'withSchedulingTracing.js']) {
    write('plugins/' + file, fs.readFileSync(path.join(root, 'plugins', file), 'utf8'));
  }
  for (const name of ['SchedulingBridge', 'SchedulingRetention', 'SchedulingTrace', 'DeepAsyncTrace',
    'StartupDiagnosticsModule', 'RequestOrigins', 'NativeHttpEvidence', 'HeadlessTaskLifetimes']) {
    const file = 'modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/' + name + '.kt';
    write(file, fs.readFileSync(path.join(root, file), 'utf8'));
  }
  for (const file of ['src/androidTrackingRecovery.ts', 'src/schedulingTrace.ts', 'src/deepAsyncTrace.ts']) {
    write(file, fs.readFileSync(path.join(root, file), 'utf8'));
  }
  write('node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/SchedulingProbe.kt',
    hooks.javaProbe);
  write('android/settings.gradle', plugin.settings);
  write('android/app/build.gradle', plugin.monitorGradle);
});
afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

it('records original-to-transformed source hashes without calling source evidence compiled proof', () => {
  const result = run('--sources-only');
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.boundary).toContain('PREBUILD_ONLY');
  expect(report.compiled).toEqual([]);
  expect(report.sources[0].originalSha256).not.toBe(report.sources[0].transformedSha256);
});
it('rejects a stale copy of the corrected native header', () => {
  write('node_modules/react-native/ReactCommon/react/runtime/SchedulingCore.h', '// stale');
  expect(run('--sources-only').status).not.toBe(0);
});
it('rejects missing actual source instrumentation', () => {
  write('node_modules/react-native/ReactCommon/react/runtime/TimerManager.cpp', '// original');
  expect(run('--sources-only').status).not.toBe(0);
});
it('rejects a stale generator even if the current dependency input looks correct', () => {
  write('plugins/schedulingHooks.js', '// stale generator');
  expect(run('--sources-only').status).not.toBe(0);
});
it('rejects an old module header that would overwrite the corrected dependency at regeneration', () => {
  write('modules/startup-diagnostics/native/SchedulingCore.h', '// old TLS implementation');
  expect(run('--sources-only').status).not.toBe(0);
});
it('cannot pass compiled verification with only perfectly transformed source', () => {
  write('fake-ndk/source.properties', 'Pkg.Revision = 27.1.12297006');
  const result = run(path.join(fixture, 'fake-ndk'));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('current Release compile database');
});
it('rejects stale persistence/collector source in the actual app module', () => {
  write('modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/SchedulingTrace.kt', '// stale');
  expect(run('--sources-only').status).not.toBe(0);
});
it('registers a non-release gate with all-ABI cold execution and actual Gradle compilation', () => {
  expect(require('../../package.json').scripts['verify:diagnostic78']).toContain('verify-diagnostic78-gate.sh');
  const gate = fs.readFileSync(path.join(root, 'scripts/verify-diagnostic78-gate.sh'), 'utf8');
  expect(gate).toContain('set -euo pipefail');
  expect(gate).toContain('verify-scheduling-ndk.sh');
  expect(gate).toContain('externalNativeBuildRelease');
  expect(gate).toContain('compiled-manifest.json');
  expect(gate).toContain('mergeDexRelease');
  expect(gate).toContain('Invalid stack map table');
  expect(plugin.monitorGradle).toContain('COMPUTE_FRAMES_FOR_INSTRUMENTED_CLASSES');
  expect(fs.readFileSync(path.join(root, 'scripts/verify-scheduling-tracing.sh'), 'utf8'))
    .toContain('-Xexplicit-api=strict');
  for (const script of ['verify-request-origins.sh', 'verify-scheduling-tracing.sh', 'verify-scheduling-integration.sh']) {
    expect(fs.readFileSync(path.join(root, 'scripts', script), 'utf8')).not.toMatch(/^javac (?!.*--release 17)/m);
  }
  expect(gate).not.toMatch(/(?:npx\s+eas|bundleRelease|assembleRelease)/);
});
