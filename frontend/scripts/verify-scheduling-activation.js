#!/usr/bin/env node
// Configuration-only child processes; never changes the working release identity.
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let checks = 0;
for (const selected of [null, '70', '77', '78', '79', 'invalid']) {
  const env = { ...process.env };
  delete env.KINNSHIP_DIAGNOSTIC_BUILD;
  if (selected !== null) env.KINNSHIP_DIAGNOSTIC_BUILD = selected;
  const text = execFileSync(process.execPath, ['-e', `
    const {getConfig}=require('@expo/config');
    const {exp}=getConfig(process.cwd(),{skipSDKVersionRequirement:true});
    const build=require('./plugins/diagnosticBuild').diagnosticBuild();
    const p=require('./plugins/withSchedulingTracing');
    const c={name:'fixture',slug:'fixture'};
    const applied=p(c);
    console.log(JSON.stringify({build,version:exp.android.versionCode,
      newArchitecture:exp.newArchEnabled,package:exp.android.package,
      scheduling:!!applied.mods,runtime:exp.android.runtimeVersion||exp.runtimeVersion}));
  `], { cwd: root, env, encoding: 'utf8' }).trim();
  const row = JSON.parse(text.split('\n').at(-1));
  const expected = selected && /^\d+$/.test(selected) && Number(selected) >= 71 ? Number(selected) : null;
  assert.equal(row.version, expected || 70); checks++;
  assert.equal(row.scheduling, expected !== null && expected >= 78); checks++;
  assert.equal(row.package, 'app.kinnship.client'); checks++;
  assert.equal(row.newArchitecture, true); checks++;
  console.log(`PASS config ${selected ?? 'unset'}: scheduling=${row.scheduling}, version=${row.version}`);
}
console.log(`PASS ${checks} activation assertions; child-only identity selection, no release changes`);
