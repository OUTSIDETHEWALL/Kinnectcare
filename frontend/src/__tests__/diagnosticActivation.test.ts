/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { diagnosticBuild } = require('../../plugins/diagnosticBuild');
const startup = require('../../plugins/withAndroidStartupRecorder');
const root = path.resolve(__dirname, '../..');

describe('real diagnostic config-plugin entrypoint activation', () => {
  const original = process.env.KINNSHIP_DIAGNOSTIC_BUILD;
  afterEach(() => {
    if (original === undefined) delete process.env.KINNSHIP_DIAGNOSTIC_BUILD;
    else process.env.KINNSHIP_DIAGNOSTIC_BUILD = original;
  });

  test.each(['75', '76', '77', '78', '79', '125'])('diagnostic %s registers real Gradle instrumentation', async code => {
    process.env.KINNSHIP_DIAGNOSTIC_BUILD = code;
    expect(diagnosticBuild()).toBe(Number(code));
    const config = startup({ name: 'Kinnship', slug: 'kinnship' });
    const result = await config.mods.android.appBuildGradle({
      ...config, modResults: { contents: 'android {}', language: 'groovy' },
      modRequest: { projectRoot: root, platformProjectRoot: path.join(root, 'android') },
    });
    expect(result.modResults.contents).toContain('KinnshipDeepAsyncFactory');
    expect(result.modResults.contents).toContain('variant.instrumentation.transformClassesWith');
    expect(result.modResults.contents).toContain('InstrumentationScope.ALL');
    expect(config.mods.android.dangerous).toBeDefined();
  });

  test.each([undefined, '', '70', 'unexpected', '077', '77.5', '-77', '2100000001'])('normal/invalid selection %s cannot activate deep hooks', code => {
    if (code === undefined) delete process.env.KINNSHIP_DIAGNOSTIC_BUILD;
    else process.env.KINNSHIP_DIAGNOSTIC_BUILD = code;
    expect(diagnosticBuild()).toBeNull();
    const config = startup({ name: 'Kinnship', slug: 'kinnship' });
    expect(config.mods.android.appBuildGradle).toBeUndefined();
  });

  test.each(['77', '78', '79'])('future identity %s needs no allowlist edit and preserves all other config', code => {
    const identify = (selected?: string) => {
      const env = { ...process.env };
      delete env.KINNSHIP_DIAGNOSTIC_BUILD;
      if (selected) env.KINNSHIP_DIAGNOSTIC_BUILD = selected;
      return JSON.parse(execFileSync(process.execPath, ['-e', `
        const c = require('./app.config.js')({config:{}}).expo;
        const result = {code:c.android.versionCode,runtime:c.android.runtimeVersion};
        delete c.android.versionCode; delete c.android.runtimeVersion;
        result.other = require('node:crypto').createHash('sha256').update(JSON.stringify(c)).digest('hex');
        console.log(JSON.stringify(result));
      `], { cwd: root, env, encoding: 'utf8' }));
    };
    const baseline = identify();
    expect(baseline.code).toBe(70);
    expect(identify(code)).toEqual({ code: Number(code), runtime: `1.3.1-diagnostic${code}`, other: baseline.other });
  });

  test('Build 77 uses a distinct AAB identity without auto submission', () => {
    const profiles = require('../../eas.json').build;
    expect(profiles.diagnostic77).toEqual({
      extends: 'production', environment: 'production', distribution: 'store',
      channel: 'diagnostic77', autoIncrement: false, env: { KINNSHIP_DIAGNOSTIC_BUILD: '77' },
    });
    expect(profiles.diagnostic77.autoSubmit).toBeUndefined();
    expect(profiles.production.channel).toBe('production');
  });
});
