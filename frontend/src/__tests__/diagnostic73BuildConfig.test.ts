/* eslint-disable @typescript-eslint/no-require-imports */
/** Metadata-only checks; never load application/native modules or print licenses. */
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

describe('diagnostic Build 73 exact identity and isolated compatibility', () => {
  it('adds only a production-style, non-incrementing diagnostic profile', () => {
    expect(profiles.diagnostic73).toEqual({
      extends: 'production', environment: 'production', channel: 'diagnostic73',
      autoIncrement: false, env: { KINNSHIP_DIAGNOSTIC_BUILD: '73' },
    });
    expect(profiles.production.channel).toBe('production');
    expect(profiles.production.android.buildType).toBe('app-bundle');
  });

  it('changes only Android versionCode/runtime and preserves every other setting', () => {
    const baseline = identity();
    expect(baseline.code).toBe(70);
    expect(baseline.runtime).toBeUndefined();
    for (const code of [71, 72, 73]) {
      expect(identity(String(code))).toEqual({
        ...baseline, code, runtime: `1.3.1-diagnostic${code}`,
      });
    }
    expect(identity('unexpected')).toEqual(baseline);
    expect(baseline.package).toBe('app.kinnship.client');
    expect(baseline.version).toBe('1.3.1');
  });
});
