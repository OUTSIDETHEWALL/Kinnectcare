/** Build metadata only: do not load the application or any native modules. */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const profiles = require('../../eas.json').build;
const root = path.resolve(__dirname, '../..');

function config(build?: string) {
  const env = { ...process.env };
  delete env.KINNSHIP_DIAGNOSTIC_BUILD;
  if (build) env.KINNSHIP_DIAGNOSTIC_BUILD = build;
  return JSON.parse(execFileSync(process.execPath, ['-e',
    "const c=require('./app.config.js')({config:{}}).expo; console.log(JSON.stringify({version:c.version,runtime:c.runtimeVersion,ios:c.ios,android:{package:c.android.package,versionCode:c.android.versionCode,runtimeVersion:c.android.runtimeVersion}}))",
  ], { cwd: root, env, encoding: 'utf8' }));
}

describe('diagnostic Build 72 identity and OTA isolation', () => {
  it('uses a production-style AAB profile with no automatic increment', () => {
    expect(profiles.diagnostic72).toEqual({
      extends: 'production', environment: 'production', channel: 'diagnostic72',
      autoIncrement: false, env: { KINNSHIP_DIAGNOSTIC_BUILD: '72' },
    });
    expect(profiles.production.android.buildType).toBe('app-bundle');
    expect(profiles.production.channel).toBe('production');
  });
  it('isolates Android 72 while preserving production and diagnostic71', () => {
    const production = config();
    const previous = config('71');
    const diagnostic = config('72');
    expect(production.android).toEqual({ package: 'app.kinnship.client', versionCode: 70 });
    expect(previous.android).toEqual({
      package: 'app.kinnship.client', versionCode: 71, runtimeVersion: '1.3.1-diagnostic71',
    });
    expect(diagnostic.android).toEqual({
      package: 'app.kinnship.client', versionCode: 72, runtimeVersion: '1.3.1-diagnostic72',
    });
    expect(diagnostic.version).toBe('1.3.1');
    expect(diagnostic.ios).toEqual(production.ios);
    expect(diagnostic.runtime).toEqual(production.runtime);
    expect(config('unexpected').android).toEqual(production.android);
  });
});
