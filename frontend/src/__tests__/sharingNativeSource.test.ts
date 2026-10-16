import fs from 'fs';
import path from 'path';

describe('pinned Expo Sharing native patch (source checks, not Android execution)', () => {
  it('covers result, cancellation, exceptions, Activity return and recreation with operation-scoped cleanup', () => {
    const { patchSharing } = require('../../plugins/withReliableSharing');
    const original = fs.readFileSync(path.resolve(__dirname,
      '../../node_modules/expo-sharing/android/src/main/java/expo/modules/sharing/SharingModule.kt'), 'utf8');
    const patched = patchSharing(original);
    expect(patchSharing(patched)).toBe(patched);
    expect(patched).toContain('pendingPromise !== expected');
    expect(patched).toContain('clearShare(promise)\n        throw');
    expect(patched).toContain('requestCode == pendingRequestCode');
    expect(patched).toContain('OnActivityEntersBackground');
    expect(patched).toContain('OnActivityEntersForeground');
    expect(patched).toContain('OnActivityDestroys { interruptShare() }');
    expect(patched).toContain('OnDestroy { interruptShare() }');
    expect(patched).not.toContain('startActivityForResult(intent, REQUEST_CODE)');
    expect(patched).not.toContain('pendingPromise?.resolve');
    expect(() => patchSharing('unsupported upstream module')).toThrow(/source changed/);
  });
});
