import fs from 'fs';
import path from 'path';

const mockNative = {
  originVersion: jest.fn(() => 1),
  originBind: jest.fn(),
  originRecord: jest.fn(),
  originRead: jest.fn(() => '{"available":true}'),
};
jest.mock('expo', () => ({ requireOptionalNativeModule: () => mockNative }));

describe('local request-origin propagation', () => {
  const globalHooks = globalThis as any;
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete globalHooks.__kinnshipBindRequestOrigin;
    delete globalHooks.__kinnshipTaskSettled;
  });
  it('separates 120 synchronous dispatches and restores nested/throwing scopes', () => {
    const { operationOrigin, originPhase, withRequestOrigin } = require('../requestOrigin');
    const left = operationOrigin('sdk-headless', 'a'.repeat(32), 7);
    const right = operationOrigin('patrol');
    const calls: number[] = [];
    for (let i = 1; i <= 120; i++) {
      const context = i % 2 ? left : right;
      withRequestOrigin(originPhase(context, 'second-ownership'), () => {
        calls.push(i);
        globalHooks.__kinnshipBindRequestOrigin(i);
      });
    }
    expect(mockNative.originBind).toHaveBeenCalledTimes(120);
    const records = mockNative.originBind.mock.calls.map((args: any[]) => JSON.parse(args[1]));
    expect(new Set(records.map((row: any) => row.request)).size).toBe(120);
    expect(records.filter((row: any) => row.operation === left.operation)).toHaveLength(60);
    expect(records.filter((row: any) => row.operation === right.operation)).toHaveLength(60);
    withRequestOrigin(left, () => {
      expect(() => withRequestOrigin(right, () => { throw new Error('original'); })).toThrow('original');
      globalHooks.__kinnshipBindRequestOrigin(121);
    });
    globalHooks.__kinnshipBindRequestOrigin(122);
    expect(JSON.parse((mockNative.originBind.mock.calls.at(-2) as any)[1]).operation).toBe(left.operation);
    expect(JSON.parse((mockNative.originBind.mock.calls.at(-1) as any)[1]).origin).toBe('unattributed');
    expect(JSON.stringify(records)).not.toMatch(/Authorization|Bearer|latitude|longitude/);
  });
  it('does not leave an origin active across an await or change promise identity', async () => {
    const { operationOrigin, withRequestOrigin } = require('../requestOrigin');
    const context = operationOrigin('sdk-headless');
    const promise = Promise.resolve('unchanged');
    expect(withRequestOrigin(context, () => promise)).toBe(promise);
    await promise;
    globalHooks.__kinnshipBindRequestOrigin(1);
    expect(JSON.parse((mockNative.originBind.mock.calls.at(-1) as any)[1]).origin).toBe('unattributed');
  });
  it('contains observer failures and records task settlement without altering completion', () => {
    const { operationOrigin, withRequestOrigin } = require('../requestOrigin');
    const context = operationOrigin('sdk-headless');
    mockNative.originBind.mockImplementationOnce(() => { throw new Error('observer'); });
    expect(withRequestOrigin(context, () => {
      globalHooks.__kinnshipBindRequestOrigin(1); return 'original-result';
    })).toBe('original-result');
    globalHooks.__kinnshipTaskSettled('b'.repeat(32), 29);
    expect(mockNative.originRecord).toHaveBeenLastCalledWith('task', 'b'.repeat(32), 'js_settled',
      expect.stringContaining('"taskId":29'));
  });
  it('uses new opaque runtime identity after recreation; old binaries have no fallback header', () => {
    const first = require('../requestOrigin');
    first.withRequestOrigin(first.operationOrigin('patrol'), () => globalHooks.__kinnshipBindRequestOrigin(1));
    const before = JSON.parse((mockNative.originBind.mock.calls.at(-1) as any)[1]);
    delete globalHooks.__kinnshipBindRequestOrigin;
    delete globalHooks.__kinnshipTaskSettled;
    jest.resetModules();
    const second = require('../requestOrigin');
    second.withRequestOrigin(second.operationOrigin('patrol'), () => globalHooks.__kinnshipBindRequestOrigin(1));
    const after = JSON.parse((mockNative.originBind.mock.calls.at(-1) as any)[1]);
    expect(before.runtime).not.toBe(after.runtime);
    mockNative.originVersion.mockReturnValueOnce(0);
    expect(second.requestOriginAvailable()).toBe(false);
  });
});

describe('source hooks against the installed dependency versions', () => {
  const root = path.resolve(__dirname, '../..');
  const hooks = require('../../plugins/requestOriginHooks');
  const evidence = require('../../plugins/withAndroidEvidenceTracing');
  const read = (relative: string) => fs.readFileSync(path.join(root, 'node_modules', relative), 'utf8');
  it('is idempotent, validates source drift, and does not alter native request policy', () => {
    const source = read('react-native/Libraries/Network/RCTNetworking.android.js');
    const changed = hooks.rnJs(source);
    expect(hooks.rnJs(changed)).toBe(changed);
    expect(changed).toContain('global.__kinnshipBindRequestOrigin?.(requestId)');
    expect(changed.indexOf('__kinnshipBindRequestOrigin')).toBeLessThan(changed.indexOf('NativeNetworkingAndroid.sendRequest('));
    expect(() => hooks.rnJs('incompatible source')).toThrow('Origin source drift');
    const sdk = read('react-native-background-geolocation/src/index.js');
    const settled = hooks.sdkJs(sdk);
    expect(hooks.sdkJs(settled)).toBe(settled);
    expect(settled.match(/kcSettled\('(fulfilled|rejected)'\);/g)).toHaveLength(2);
    const manager = hooks.manager(evidence.manager(read('react-native-background-geolocation/android/src/main/java/com/transistorsoft/rnbackgroundgeolocation/HeadlessTaskManager.java')));
    expect(hooks.manager(manager)).toBe(manager);
    expect(manager).toContain('"removed", task.getReactTaskId(), task.mTimeout');
    expect(manager).toContain('"invoked", mReactTaskId, mTimeout');
    expect(manager).toContain('if (task == null) KinnshipOriginBridge.missing(context, taskId);');
    expect(manager).toContain('mReactTaskId = headlessJsTaskContext.startTask(buildTaskConfig());');
  });
});
