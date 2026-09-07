import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');
const authContext = fs.readFileSync(path.join(projectRoot, 'src/AuthContext.tsx'), 'utf8');
const rootLayout = fs.readFileSync(path.join(projectRoot, 'app/_layout.tsx'), 'utf8');

describe('auth startup recorder terminal contract', () => {
  it('uses one finally checkpoint for every restore return or unexpected throw', () => {
    expect(authContext).toContain("let authRestoreTerminal: 'auth_restore_completed' | 'auth_restore_failed' = 'auth_restore_failed';");
    expect(authContext).toContain('} finally {');
    expect(authContext.match(/recordNativeStartupCheckpoint\(authRestoreTerminal/g)).toHaveLength(1);
    expect(authContext).not.toContain("recordNativeStartupCheckpoint('auth_restore_completed'");
    expect(authContext).not.toContain("recordNativeStartupCheckpoint('auth_restore_failed'");
  });

  it('derives terminal authentication from the actual final restore state', () => {
    // Cache miss + successful /auth/me and retry-success both set this true.
    expect(authContext.match(/restoredUser = true;/g)?.length).toBeGreaterThanOrEqual(2);
    // Confirmed two-401 token clearing explicitly removes an earlier cache restore.
    expect(authContext).toContain('setUser(null);\n          restoredUser = false;');
    // A non-cached failed request is terminal failure; a retained cache is completed.
    expect(authContext).toContain("authRestoreFailed && !restoredUser\n        ? 'auth_restore_failed'\n        : 'auth_restore_completed'");
  });

  it('labels router evidence as a pathname observation, without readiness claims', () => {
    expect(rootLayout).toContain("recordNativeStartupCheckpoint('expo_router_pathname_observed'");
    expect(rootLayout).not.toContain('expo_router_navigation_observed_stable');
    expect(rootLayout).not.toContain('NavigationContainer ready');
  });
});