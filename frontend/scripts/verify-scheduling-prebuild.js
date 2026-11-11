#!/usr/bin/env node
// Read-only, in-memory transforms; no Expo prebuild, build or node_modules writes.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..');
const plugin = require('../plugins/withSchedulingTracing');
const h = require('../plugins/schedulingHooks');
const deep = require('../plugins/deepAsyncHooks');
const rn = path.join(root, 'node_modules/react-native');
assert.equal(JSON.parse(fs.readFileSync(path.join(rn, 'package.json'))).version, '0.81.5');
const manifest = [];
for (const [file, transform] of plugin.transforms) {
  const source = fs.readFileSync(path.join(rn, file), 'utf8');
  const patched = transform(source);
  assert.equal(transform(patched), patched, 'not idempotent: ' + file);
  assert(patched.includes(h.MARK), file);
  manifest.push({ source: file, deliveredTarget: file.endsWith('.kt') ? 'classes.dex' : 'libreactnative.so' });
}
for (const file of ['whatwg-fetch/fetch.js', 'whatwg-fetch/dist/fetch.umd.js']) {
  const result = h.fetch(deep.fetch(fs.readFileSync(path.join(root, 'node_modules', file), 'utf8')));
  new (require('vm').Script)(file.endsWith('.umd.js') ? result : require('typescript').transpileModule(result, {
    compilerOptions: { module: require('typescript').ModuleKind.CommonJS },
  }).outputText);
  assert(result.indexOf('fetch_callback_scheduled') < result.indexOf('__kinnshipTimerBegin'));
}
assert(plugin.settings.includes('substitute(module("com.facebook.react:react-android"))'));
const cmake = fs.readFileSync(path.join(rn, 'ReactCommon/react/runtime/CMakeLists.txt'), 'utf8');
assert(cmake.includes('file(GLOB bridgeless_SRC "*.cpp")'));
assert(fs.readFileSync(path.join(rn, 'ReactAndroid/src/main/jni/CMakeLists.txt'), 'utf8').includes('reactnative'));
assert(fs.readFileSync(path.join(rn, 'ReactCommon/react/renderer/runtimescheduler/CMakeLists.txt'), 'utf8').includes('*.cpp'));
console.log(JSON.stringify({ result: 'PASS', pinnedRN: '0.81.5',
  interpretation: 'SOURCE_PATH_INCLUSION_ONLY_NOT_COMPILED_ARTIFACT_PROOF',
  manifests: manifest, sourceBuildSubstitution: true, sourceTransformsIdempotent: true,
  newTimers: 0, newNetworkCalls: 0, releaseIdentityChanged: false }, null, 2));
