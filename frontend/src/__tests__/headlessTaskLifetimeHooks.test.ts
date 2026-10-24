import fs from 'fs';
import path from 'path';
const hooks = require('../../plugins/headlessTaskLifetimeHooks');
const evidence = require('../../plugins/withAndroidEvidenceTracing');
const origins = require('../../plugins/requestOriginHooks');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root,
  'node_modules/react-native-background-geolocation/android/src/main/java/com/transistorsoft/rnbackgroundgeolocation/HeadlessTaskManager.java'), 'utf8');

describe('production native task lifetime hook composition', () => {
  it('composes with both Build 73 observers and remains idempotent', () => {
    const result = hooks.manager(origins.manager(evidence.manager(source)));
    expect(hooks.manager(result)).toBe(result);
    expect(result).toContain('KinnshipRequestOrigins');
    expect(result).toContain('KinnshipBoundedEvidence');
    expect(result).toContain('mParams.putString("kcTaskLifetime", mKinnshipLifetime)');
    expect(result).toContain('headlessJsTaskContext.isTaskRunning(mKinnshipReactTaskId)');
    expect(result.indexOf('KinnshipTaskLifetimeBridge.begin(mTimeout')).toBeLessThan(
      result.indexOf('mReactTaskId = headlessJsTaskContext.startTask(buildTaskConfig());'));
    const removal = result.slice(result.indexOf('private void removeTask(Task task) {'));
    expect(removal.indexOf('KinnshipTaskLifetimeBridge.end')).toBeLessThan(removal.indexOf('KinnshipOriginBridge.task'));
    expect(result).toContain('if (task != null) KinnshipTaskLifetimeBridge.end(task.mKinnshipLifetime);');
    // Finishing and observer callbacks still exist; this is not an SDK rewrite.
    expect(result).toContain('task.onFinish();');
    expect(result).toContain('headlessJsTaskContext.finishTask(task.getReactTaskId());');
  });
  it('fails on source drift rather than shipping an unfenced binary', () => {
    expect(() => hooks.manager('class Changed {}')).toThrow('source drift');
    expect(() => hooks.manager(source.replace('private void removeTask(Task task) {', 'void changed() {'))).toThrow('source drift');
  });
  it('retains reflected operational entrypoints through release shrinking', () => {
    const rules = fs.readFileSync(path.join(root, 'modules/startup-diagnostics/android/consumer-rules.pro'), 'utf8');
    expect(rules).toContain('-keep class expo.modules.startupdiagnostics.HeadlessTaskLifetimes');
    expect(rules).toContain('begin(int, java.util.function.BooleanSupplier)');
    expect(rules).toContain('end(java.lang.String)');
  });
});
