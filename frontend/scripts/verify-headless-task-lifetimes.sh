#!/usr/bin/env bash
# Local source compilation/JVM simulation only: no APK/AAB, prebuild, EAS or release.
set -euo pipefail
cd "$(dirname "$0")/.."
work="$(mktemp -d /tmp/kinnship-task-lifetimes.XXXXXX)"
trap 'rm -rf "$work"' EXIT
cache=/tmp/kinnship-origin-compile
if ! test -f "$cache/react-android.jar" || ! test -f "$cache/android-api19-surface.jar"; then
  bash scripts/verify-request-origins.sh
fi
mkdir -p "$work/classes" "$work/generated"
cp="$cache/android-api19-surface.jar:$cache/json.jar:$cache/react-android.jar"
if ! test -f "$cache/infer-annotation.jar"; then
  curl -fLsS https://repo.maven.apache.org/maven2/com/facebook/infer/annotation/infer-annotation/0.18.0/infer-annotation-0.18.0.jar -o "$cache/infer-annotation.jar"
fi
cp="$cp:$cache/infer-annotation.jar"
kotlinlib="$(dirname "$(readlink -f "$(command -v kotlinc)")")/../lib/kotlin-stdlib.jar"
native=modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics
kotlinc -classpath "$cp" "$native/HeadlessTaskLifetimes.kt" -d "$work/lifetimes.jar"
echo "PASS production HeadlessTaskLifetimes.kt compilation against Android API"
node - "$work/generated" <<'JS'
const fs = require('fs');
const out = process.argv[2];
const evidence = require('./plugins/withAndroidEvidenceTracing');
const origins = require('./plugins/requestOriginHooks');
const lifetime = require('./plugins/headlessTaskLifetimeHooks');
const pkg = 'com.transistorsoft.rnbackgroundgeolocation';
const source = fs.readFileSync('node_modules/react-native-background-geolocation/android/src/main/java/com/transistorsoft/rnbackgroundgeolocation/HeadlessTaskManager.java', 'utf8');
fs.writeFileSync(out + '/HeadlessTaskManager.java', lifetime.manager(origins.manager(evidence.manager(source))));
fs.writeFileSync(out + '/KinnshipEvidenceBridge.java', evidence.bridge(pkg));
fs.writeFileSync(out + '/KinnshipOriginBridge.java', origins.bridge(pkg));
fs.writeFileSync(out + '/KinnshipTaskLifetimeBridge.java', lifetime.bridge(pkg));
JS
javac -cp "$cp:$kotlinlib:$work/lifetimes.jar" -d "$work/classes" \
  scripts/task-lifetime-contract/*.java "$work/generated/"*.java
echo "PASS all three composed hooks + actual SDK HeadlessTaskManager source against RN 0.81.5 release API"
runtime="$work/classes:$work/lifetimes.jar:$cp"
kotlinc -classpath "$runtime" scripts/task-lifetime-contract/LifetimeHarness.kt -d "$work/harness.jar"
kotlin -classpath "$runtime:$work/harness.jar" LifetimeHarnessKt "$work/prior-process-token"
# Separate JVM: no persisted token can be adopted by a new process.
kotlin -classpath "$runtime:$work/harness.jar" LifetimeHarnessKt "$work/prior-process-token"
echo "LIMIT: logger/annotations/clock are substitutes; no Android app or shrinker build was run"
