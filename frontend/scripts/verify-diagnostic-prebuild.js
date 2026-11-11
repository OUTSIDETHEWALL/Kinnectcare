#!/usr/bin/env node
// Read-only verification of an isolated real Expo prebuild. Never submits EAS.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const parser = require('@babel/parser');
const root = path.resolve(process.argv[2] || '.');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const gradle = read('android/app/build.gradle');
const plugin = require('../plugins/withDeepAsyncTracing');
assert(gradle.includes(plugin.gradle), 'Real plugin Gradle registration/visitor differs or is missing');

function stageCalls(file) {
  const ast = parser.parse(read('node_modules/' + file), { sourceType: 'unambiguous', plugins: ['flow', 'jsx'] });
  const stages = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if ((node.type === 'OptionalCallExpression' || node.type === 'CallExpression') &&
        node.callee?.property?.name === '__kinnshipAsyncStage') {
      const stage = node.arguments[1];
      assert.equal(stage?.type, 'StringLiteral');
      stages.add(stage.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast);
  return stages;
}
const groups = [
  ['react-native/Libraries/Network/XMLHttpRequest.js', ['xhr_response_received', 'xhr_data_received', 'xhr_completion_received']],
  ['react-native/Libraries/Blob/FileReader.js', ['js_body_read_entered', 'js_body_read_received', 'js_body_read_rejected']],
  ...['whatwg-fetch/fetch.js', 'whatwg-fetch/dist/fetch.umd.js'].map(file => [file, [
    'fetch_callback_received', 'fetch_callback_scheduled', 'fetch_callback_executed',
    'body_read_entered', 'body_type_blob', 'body_type_buffer', 'body_type_text',
    'body_read_fulfilled', 'json_parse_entered', 'json_parse_completed', 'json_parse_failed', 'body_read_rejected',
  ]]),
];
const result = {};
for (const [file, expected] of groups) {
  const calls = stageCalls(file);
  for (const stage of expected) assert(calls.has(stage), 'Missing actual transformed JS call: ' + stage);
  result[file] = { present: expected.length, expected: expected.length };
}
const app = read('android/app/src/main/java/app/kinnship/client/MainApplication.kt');
assert(app.includes('RecorderBootstrap.start(this)'), 'Independent recorder bootstrap missing');
const native = 'modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/';
for (const name of ['DeepAsyncTrace', 'RequestOrigins', 'EvidenceTrace', 'RecorderWorker', 'RecorderMap', 'RecorderBootstrap']) {
  const current = fs.readFileSync(path.resolve(__dirname, '../' + native + name + '.kt'));
  assert(current.equals(fs.readFileSync(path.join(root, native + name + '.kt'))), name + ' differs from validated safety source');
}
const deep = read(native + 'DeepAsyncTrace.kt');
assert(deep.includes('everPathological') && deep.includes('protectedIds'), 'Preferential retention missing');
assert(read('src/diagnosticsFull.tsx').includes('deepAsyncEvidence: readDeepAsyncTrace()'), 'Full Diagnostics export missing');
assert(read('src/initialOwnershipReads.ts').includes("'aggregate_fulfilled'"), 'Flight settlement missing');
assert(read('src/batteryTask.ts').includes("'workmanager_contact_resumed'"), 'WorkManager correlation missing');
console.log(JSON.stringify({ generatedGradleRegistration: true, dependencyJsCallSites: result,
  nonblockingNativeSourcesIdentical: true, pathologicalRetention: true, fullDiagnosticsExport: true,
  sharedFlightSettlement: true, workManagerCorrelation: true }, null, 2));
