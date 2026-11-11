/* eslint-disable @typescript-eslint/no-require-imports */
/** Build identity only: never emit credentials or load application modules. */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const profiles = require('../../eas.json').build;
const root = path.resolve(__dirname, '../..');

function identity(build?: string) {
  const env = { ...process.env };
  delete env.KINNSHIP_DIAGNOSTIC_BUILD;
  if (build) env.KINNSHIP_DIAGNOSTIC_BUILD = build;
  return JSON.parse(execFileSync(process.execPath, ['-e', `
    const c = require('./app.config.js')({config:{}}).expo;
    const identity = { package: c.android.package, version: c.version,
      code: c.android.versionCode, runtime: c.android.runtimeVersion };
    delete c.android.versionCode; delete c.android.runtimeVersion;
    identity.remainingConfigHash = require('node:crypto').createHash('sha256')
      .update(JSON.stringify(c)).digest('hex');
    console.log(JSON.stringify(identity));
  `], { cwd: root, env, encoding: 'utf8' }));
}

describe('Build 74 diagnostic identity without production or GPS changes', () => {
  it('uses an isolated non-incrementing native AAB profile without submission', () => {
    expect(profiles.diagnostic74).toEqual({
      extends: 'production', environment: 'production', channel: 'diagnostic74',
      autoIncrement: false, env: { KINNSHIP_DIAGNOSTIC_BUILD: '74' },
    });
    expect(profiles.production.channel).toBe('production');
    expect(profiles.production.android.buildType).toBe('app-bundle');
    expect(profiles.diagnostic74.autoSubmit).toBeUndefined();
  });

  it('changes only Android build number and runtime, preserving all other config', () => {
    const baseline = identity();
    expect(baseline.code).toBe(70);
    expect(baseline.runtime).toBeUndefined();
    expect(baseline.package).toBe('app.kinnship.client');
    expect(baseline.version).toBe('1.3.1');
    for (const code of [71, 72, 73, 74]) {
      expect(identity(String(code))).toEqual({
        ...baseline, code, runtime: `1.3.1-diagnostic${code}`,
      });
    }
    expect(identity('unexpected')).toEqual(baseline);
  });
});
