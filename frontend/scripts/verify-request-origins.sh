#!/usr/bin/env bash
# Standalone local compile/simulation only. Never creates an APK/AAB or invokes EAS.
set -euo pipefail
cd "$(dirname "$0")/.."
work="$(mktemp -d /tmp/kinnship-origin-contract.XXXXXX)"
trap 'rm -rf "$work"' EXIT
cache=/tmp/kinnship-origin-compile
mkdir -p "$cache"
for spec in \
  'android-api19.jar https://repo.maven.apache.org/maven2/org/robolectric/android-all/4.4_r1-robolectric-r2/android-all-4.4_r1-robolectric-r2.jar' \
  'json.jar https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar' \
  'okhttp.jar https://repo.maven.apache.org/maven2/com/squareup/okhttp3/okhttp/4.12.0/okhttp-4.12.0.jar' \
  'okio.jar https://repo.maven.apache.org/maven2/com/squareup/okio/okio-jvm/3.6.0/okio-jvm-3.6.0.jar'; do
  read -r out url <<< "$spec"
  test -f "$cache/$out" || curl -fLsS "$url" -o "$cache/$out"
done
if ! test -f "$cache/react-android.jar"; then
  curl -fLsS https://repo.maven.apache.org/maven2/com/facebook/react/react-android/0.81.5/react-android-0.81.5-release.aar -o "$cache/react-android.aar"
  unzip -p "$cache/react-android.aar" classes.jar > "$cache/react-android.jar"
fi
# Robolectric's API archive contains old java.* boot classes too. They are not
# Android SDK stubs and must not shadow the host JDK's ConcurrentHashMap APIs.
if ! test -f "$cache/android-api19-surface.jar"; then
  python3 - "$cache/android-api19.jar" "$cache/android-api19-surface.jar" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as target:
    for entry in source.infolist():
        if not entry.filename.startswith(("java/", "javax/", "org/json/")):
            target.writestr(entry, source.read(entry.filename))
PY
fi
cp="$cache/json.jar:$cache/android-api19-surface.jar:$cache/okhttp.jar:$cache/okio.jar"
kotlinlib="$(dirname "$(readlink -f "$(command -v kotlinc)")")/../lib/kotlin-stdlib.jar"
mkdir -p "$work/classes" "$work/bridge"
# Source transformations are evaluated in memory, not applied to node_modules.
node - "$work/bridge" <<'JS'
const fs = require('fs');
const out = process.argv[2];
const hooks = require('./plugins/requestOriginHooks');
fs.writeFileSync(out + '/KinnshipOriginBridge.java', hooks.bridge('com.transistorsoft.rnbackgroundgeolocation'));
JS
javac -cp "$cp:$kotlinlib" -d "$work/classes" scripts/origin-contract/NetworkingModule.java scripts/origin-contract/ReadableMap.java
native=modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics
# Compile against the actual RN 0.81.5 release classes, not just the runtime shim.
kotlinc -classpath "$cp:$cache/react-android.jar" \
  "$native/RequestOrigins.kt" "$native/NativeHttpEvidence.kt" \
  "$native/EvidenceTrace.kt" "$native/EvidenceStore.kt" -d "$work/production.jar"
javac -cp "$cp:$work/classes" -d "$work/classes" "$work/bridge/KinnshipOriginBridge.java"
echo 'PASS production observers against actual RN 0.81.5 / Android / OkHttp APIs; generated bridge compilation'
javap -classpath "$work/production.jar" expo.modules.startupdiagnostics.RequestOrigins | grep -E 'static final void (record|bind|install)'
# Runtime simulations substitute Android threading/storage/clock, not the new
# production observer or OkHttp. The old verbose observer is separately stubbed.
javac -cp "$cp:$kotlinlib" -d "$work/classes" \
  scripts/origin-contract/{Context,Looper,HandlerThread,Handler,SystemClock}.java
kotlinc -classpath "$work/classes:$cp" \
  "$native/RequestOrigins.kt" "$native/NativeHttpEvidence.kt" \
  scripts/origin-contract/EvidenceTraceStub.kt -d "$work/runtime.jar"
kotlinc -classpath "$work/classes:$cp:$work/runtime.jar" \
  scripts/origin-contract/OriginHarness.kt -d "$work/harness.jar"
runtime="$work/classes:$work/runtime.jar:$work/harness.jar:$cp"
kotlin -classpath "$runtime" OriginHarnessKt "$work/state" seed
kotlin -classpath "$runtime" OriginHarnessKt "$work/state" recreate
echo 'LIMIT: local JVM simulation, not Android scheduling, release shrinker, full Expo build, or phone acceptance'
