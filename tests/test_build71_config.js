// No credential values are printed, even on comparison failure.
const assert = require('node:assert/strict');
const configPath = require.resolve('../frontend/app.config.js');
function config(value) {
  if (value === undefined) delete process.env.KINNSHIP_DIAGNOSTIC_BUILD;
  else process.env.KINNSHIP_DIAGNOSTIC_BUILD = value;
  delete require.cache[configPath];
  return require(configPath)({ config: {} }).expo;
}
const previous = process.env.KINNSHIP_DIAGNOSTIC_BUILD;
try {
  const baseline = config(undefined);
  assert.equal(baseline.android.package, 'app.kinnship.client');
  assert.equal(baseline.android.versionCode, 70);
  assert.equal(baseline.version, '1.3.1');
  assert.equal(baseline.runtimeVersion.policy, 'appVersion');
  assert.equal(baseline.android.runtimeVersion, undefined);
  const diagnostic = config('71');
  assert.equal(diagnostic.android.package, baseline.android.package);
  assert.equal(diagnostic.android.versionCode, 71);
  assert.equal(diagnostic.android.runtimeVersion, '1.3.1-diagnostic71');
  delete diagnostic.android.runtimeVersion;
  diagnostic.android.versionCode = 70;
  assert.equal(JSON.stringify(diagnostic) === JSON.stringify(baseline), true,
    'Diagnostic profile must change only Android versionCode/runtime');
  assert.equal(JSON.stringify(config('70')) === JSON.stringify(baseline), true);
  const profiles = require('../frontend/eas.json').build;
  assert.equal(profiles.production.channel, 'production');
  assert.equal(profiles.production.android.buildType, 'app-bundle');
  assert.equal(profiles.diagnostic71.extends, 'production');
  assert.equal(profiles.diagnostic71.channel, 'diagnostic71');
  assert.equal(profiles.diagnostic71.environment, 'production');
  assert.equal(profiles.diagnostic71.autoIncrement, false);
  assert.equal(profiles.diagnostic71.env.KINNSHIP_DIAGNOSTIC_BUILD, '71');
  console.log('BUILD71_CONFIG_PASS: isolated Android runtime/versionCode; defaults unchanged');
} finally {
  if (previous === undefined) delete process.env.KINNSHIP_DIAGNOSTIC_BUILD;
  else process.env.KINNSHIP_DIAGNOSTIC_BUILD = previous;
  delete require.cache[configPath];
}
