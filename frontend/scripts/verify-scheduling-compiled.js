#!/usr/bin/env node
// Read-only proof against REAL generated sources/compile databases/objects.
// Not a substitute for a successful Gradle invocation or artifact inspection.
const fs = require('fs'), path = require('path'), assert = require('assert');
const crypto = require('crypto'), cp = require('child_process');
const plugin = require('../plugins/withSchedulingTracing');
const hooks = require('../plugins/schedulingHooks');
const root = path.resolve(__dirname, '..');
const generated = path.resolve(process.argv[2] || '');
assert(generated !== root, 'Use an isolated generated project, never the application tree');
const rn = path.join(generated, 'node_modules/react-native');
const original = path.join(root, 'node_modules/react-native');
const read = p => fs.readFileSync(p, 'utf8');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = { boundary: 'PREBUILD_ONLY_NOT_DELIVERED_AAB_OR_PHONE_PROOF', sources: [], compiled: [] };
const moduleSources = ['SchedulingBridge', 'SchedulingRetention', 'SchedulingTrace', 'DeepAsyncTrace',
  'StartupDiagnosticsModule', 'RequestOrigins', 'NativeHttpEvidence', 'HeadlessTaskLifetimes'];
const moduleDir = 'modules/startup-diagnostics/android';
const modulePackage = 'expo/modules/startupdiagnostics';
assert.equal(JSON.parse(read(path.join(rn, 'package.json'))).version, '0.81.5');
for (const [name, transform] of plugin.transforms) {
  const source = path.join(original, name), actual = path.join(rn, name);
  assert.equal(read(actual), transform(read(source)), 'Stale/missing transform: ' + name);
  manifest.sources.push({ name, originalSha256: hash(source), transformedSha256: hash(actual) });
}
for (const name of ['SchedulingCore.h', 'SchedulingJni.h']) {
  const source = path.join(root, 'modules/startup-diagnostics/native', name);
  const actual = path.join(rn, 'ReactCommon/react/runtime', name);
  assert.equal(hash(source), hash(actual), 'Stale TLS correction: ' + name);
  assert.equal(hash(source), hash(path.join(generated, 'modules/startup-diagnostics/native', name)),
    'Generated project would restore an old native header: ' + name);
  manifest.sources.push({ name, sha256: hash(actual) });
}
for (const name of ['schedulingHooks.js', 'withSchedulingTracing.js']) {
  assert.equal(hash(path.join(root, 'plugins', name)), hash(path.join(generated, 'plugins', name)),
    'Stale generation template: ' + name);
}
assert.equal(read(path.join(rn, 'ReactAndroid/src/main/java/com/facebook/react/runtime/SchedulingProbe.kt')),
  hooks.javaProbe, 'Stale native producer bridge');
for (const name of [...moduleSources.map(n => `${moduleDir}/src/main/java/${modulePackage}/${n}.kt`),
  'src/androidTrackingRecovery.ts', 'src/schedulingTrace.ts', 'src/deepAsyncTrace.ts']) {
  assert.equal(hash(path.join(root, name)), hash(path.join(generated, name)),
    'Stale application diagnostic source: ' + name);
  manifest.sources.push({ name, sha256: hash(path.join(generated, name)) });
}
assert(read(path.join(generated, 'android/settings.gradle')).includes(plugin.settings.trim()),
  'Missing actual RN source dependency substitution');
assert(read(path.join(generated, 'android/app/build.gradle')).includes(plugin.monitorGradle.trim()),
  'Missing actual AGP monitor transform registration');
if (process.argv.includes('--sources-only')) {
  console.log(JSON.stringify(manifest, null, 2)); process.exit(0);
}
const ndk = path.resolve(process.argv[3] || '');
const llvm = path.join(ndk, 'toolchains/llvm/prebuilt/linux-x86_64/bin');
assert(read(path.join(ndk, 'source.properties')).includes('27.1.12297006'), 'Wrong NDK');
function run(binary, args) {
  return cp.execFileSync(binary, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function walk(dir, predicate, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, predicate, found);
    else if (predicate(p)) found.push(p);
  }
  return found;
}
// RN 0.81.5's Release Android variant uses CMake RelWithDebInfo.
const nativeRoot = path.join(rn, 'ReactAndroid/.cxx/RelWithDebInfo');
const databases = walk(nativeRoot, p => p.endsWith('/compile_commands.json'));
const cpp = plugin.transforms.map(([name]) => name).filter(name => name.endsWith('.cpp'));
for (const abi of ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64']) {
  const matches = databases.filter(p => p.includes('/' + abi + '/'));
  assert.equal(matches.length, 1, 'Need exactly one current Release compile database: ' + abi);
  const db = JSON.parse(read(matches[0]));
  const ninja = path.join(path.dirname(matches[0]), 'build.ninja');
  assert(fs.existsSync(ninja), 'No real Ninja build graph: ' + abi);
  for (const name of cpp) {
    const source = path.join(rn, name);
    const entry = db.find(row => path.resolve(row.file) === source);
    assert(entry, 'Compiler never consumed ' + name + ' for ' + abi);
    const output = entry.output || entry.command.match(/(?:^| )-o\s+("[^"]+"|\S+)/)?.[1]?.replaceAll('"', '');
    assert(output, 'Missing compiler object output');
    const object = path.resolve(entry.directory, output);
    assert(fs.statSync(object).mtimeMs >= fs.statSync(source).mtimeMs, 'Stale object: ' + object);
    assert(fs.statSync(object).mtimeMs >= fs.statSync(path.join(rn, 'ReactCommon/react/runtime/SchedulingCore.h')).mtimeMs,
      'Object predates corrected header: ' + object);
    const symbols = run(path.join(llvm, 'llvm-nm'), ['--demangle', object]);
    assert(symbols.includes('kinnship78::'), 'Object has no diagnostic code: ' + object);
    assert(!/__emutls_[^\n]*kinnship78/.test(symbols), 'Emulated producer TLS: ' + object);
    manifest.compiled.push({ abi, source: name, object, objectSha256: hash(object), command: entry.command });
  }
  const libs = walk(path.join(rn, 'ReactAndroid/build/intermediates/cxx/RelWithDebInfo'),
    p => p.endsWith('/' + abi + '/libreactnative.so'));
  assert.equal(libs.length, 1, 'Need linked whole-RN library for ' + abi);
  const symbols = run(path.join(llvm, 'llvm-nm'), ['--demangle', libs[0]]);
  for (const symbol of ['kinnship78::localOwners', 'kinnship78::localStates',
    'Java_com_facebook_react_runtime_SchedulingProbe_holdNative',
    'Java_expo_modules_startupdiagnostics_SchedulingBridge_beginNative',
    'Java_expo_modules_startupdiagnostics_SchedulingBridge_drainNative']) {
    assert(symbols.includes(symbol), 'Missing linked symbol: ' + symbol);
  }
  assert(!/__emutls_[^\n]*kinnship78/.test(symbols), 'TLS returned in whole RN library');
  manifest.compiled.push({ abi, library: libs[0], sha256: hash(libs[0]) });
}
const classes = path.join(rn, 'ReactAndroid/build/tmp/kotlin-classes/release');
for (const name of ['com/facebook/react/modules/core/JavaTimerManager',
  'com/facebook/react/modules/core/JavaTimerManager$TimerFrameCallback',
  'com/facebook/react/runtime/ReactInstance', 'com/facebook/react/runtime/SchedulingProbe']) {
  const file = path.join(classes, name + '.class');
  const bytecode = run('javap', ['-c', '-p', file]);
  assert(bytecode.includes('SchedulingProbe'), 'Missing real compiled probe call: ' + name);
  manifest.compiled.push({ class: name, sha256: hash(file) });
}
for (const name of moduleSources) {
  const file = path.join(generated, moduleDir, 'build/tmp/kotlin-classes/release', modulePackage, name + '.class');
  assert(fs.existsSync(file), 'Missing actual app diagnostic class: ' + name);
  manifest.compiled.push({ class: modulePackage + '/' + name, sha256: hash(file) });
}
// The app ASM task covers only project classes. Consume the dependency ASM path
// through D8 and inspect its actual intermediate output, not an arbitrary cache.
const intermediates = path.join(generated, 'android/app/build/intermediates');
const dexFiles = walk(intermediates,
  p => p.endsWith('.dex') && p.includes('/mergeDexRelease/'));
assert(dexFiles.length, 'No actual AGP/D8 dependency-consumer output');
const dexdump = path.join(process.env.ANDROID_HOME || '', 'build-tools/35.0.0/dexdump');
let monitorProof = null;
for (const candidate of dexFiles) {
  const bytecode = run('bash', ['-o', 'pipefail', '-c',
    '"$1" -d "$2" | awk \' /^Class #[0-9]+/ { emit=0 } /Class descriptor.*Lcom\\/facebook\\/react\\/modules\\/core\\/JavaTimerManager;/ { emit=1 } emit { print } \'',
    '_', dexdump, candidate]);
  if (/invoke-static[^\n]*SchedulingProbe[;.]+hold[:(]/.test(bytecode) &&
      /invoke-static[^\n]*SchedulingProbe[;.]+release[:(]/.test(bytecode)) {
    monitorProof = { agpDependencyDex: candidate, sha256: hash(candidate) }; break;
  }
}
assert(monitorProof, 'No actual AGP/D8-transformed JavaTimerManager with monitor cleanup');
manifest.compiled.push(monitorProof);
const bundleFiles = walk(path.join(generated, 'android/app/build/generated/assets'),
  p => p.endsWith('/index.android.bundle'));
assert.equal(bundleFiles.length, 1, 'Missing actual Metro/Hermes JS output');
const bundleStrings = run('strings', [bundleFiles[0]]);
for (const marker of ['fetch_callback_scheduled', 'abort_timer_fired',
  '__kinnshipTimerBegin', '__kinnshipTimerEnd', '__kinnshipTimerCallback']) {
  assert(bundleStrings.includes(marker), 'Compiled application omitted JS witness: ' + marker);
}
manifest.compiled.push({ jsCompilerOutput: bundleFiles[0], sha256: hash(bundleFiles[0]) });
console.log(JSON.stringify(manifest, null, 2));
