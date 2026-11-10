#!/usr/bin/env bash
# Pre-build contracts only. Does not invoke Expo prebuild, Gradle, EAS, APK or AAB.
set -euo pipefail
cd "$(dirname "$0")/.."
work="$(mktemp -d /tmp/kinnship78-contract.XXXXXX)"
trap 'rm -rf "$work"' EXIT
cache=/tmp/kinnship-origin-compile
mkdir -p "$cache"
test -f "$cache/json.jar" || curl -fLsS https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar -o "$cache/json.jar"
g++ -std=c++17 -O2 -pthread scripts/scheduling-contract/CoreHarness.cpp -o "$work/core"
"$work/core"
native=modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics
kotlinc -classpath "$cache/json.jar" "$native/SchedulingRetention.kt" scripts/scheduling-contract/RetentionHarness.kt -d "$work/retention.jar"
kotlin -classpath "$cache/json.jar:$work/retention.jar" expo.modules.startupdiagnostics.RetentionHarnessKt
# Compile the ACTUAL JNI entry points against host JNI, not a string search.
javahome="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
g++ -std=c++17 -O2 -shared -fPIC -pthread -x c++ \
  -I"$javahome/include" -I"$javahome/include/linux" -Imodules/startup-diagnostics/native \
  modules/startup-diagnostics/native/SchedulingJni.h -o "$work/libkinnship78-host.so"
nm -D "$work/libkinnship78-host.so" | grep -q 'Java_expo_modules_startupdiagnostics_SchedulingBridge_beginNative'
nm -D "$work/libkinnship78-host.so" | grep -q 'Java_com_facebook_react_runtime_SchedulingProbe_eventNative'
echo 'PASS host JNI compile/link/symbol contract (NOT delivered Android libreactnative.so)'
for spec in \
  'groovy.jar https://repo.maven.apache.org/maven2/org/apache/groovy/groovy/4.0.24/groovy-4.0.24.jar' \
  'asm.jar https://repo.maven.apache.org/maven2/org/ow2/asm/asm/9.7.1/asm-9.7.1.jar' \
  'proguard-annotations.jar https://repo.maven.apache.org/maven2/com/facebook/yoga/proguard-annotations/1.19.0/proguard-annotations-1.19.0.jar' \
  'asm-commons.jar https://repo.maven.apache.org/maven2/org/ow2/asm/asm-commons/9.7.1/asm-commons-9.7.1.jar'; do
  read -r out url <<< "$spec"
  test -f "$cache/$out" || curl -fLsS "$url" -o "$cache/$out"
done
test -f "$cache/asm-tree.jar" || curl -fLsS https://repo.maven.apache.org/maven2/org/ow2/asm/asm-tree/9.7.1/asm-tree-9.7.1.jar -o "$cache/asm-tree.jar"
test -f "$cache/react-android.jar" || {
  echo 'Run verify-request-origins.sh first to obtain the pinned RN class archive' >&2; exit 1;
}
node - "$work" <<'JS'
const fs = require('fs'), h = require('./plugins/schedulingHooks');
const { monitorGradle } = require('./plugins/withSchedulingTracing');
fs.writeFileSync(process.argv[2] + '/monitor.gradle', monitorGradle);
const rn = 'node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/';
fs.writeFileSync(process.argv[2] + '/JavaTimerManager.kt', h.javaTimer(fs.readFileSync(rn + 'modules/core/JavaTimerManager.kt', 'utf8')));
fs.writeFileSync(process.argv[2] + '/SchedulingProbe.kt', h.javaProbe);
JS
# Verify generated Kotlin native signatures against the real RN / Android surface.
kotlinc -Xexplicit-api=strict -classpath "$cache/react-android.jar:$cache/android-api19-surface.jar:$cache/proguard-annotations.jar" \
  "$work/JavaTimerManager.kt" "$work/SchedulingProbe.kt" -d "$work/timer.jar"
echo 'PASS transformed JavaTimerManager + SchedulingProbe compile against pinned RN release APIs'
javap -classpath "$work/timer.jar" com.facebook.react.runtime.SchedulingProbe | grep 'native'
mkdir -p "$work/fixture"
javac --release 17 -d "$work/fixture" scripts/scheduling-contract/{SchedulingProbe,HeadlessJsTaskContext,MonitorFixture}.java
java -cp "$cache/groovy.jar:$cache/asm.jar:$cache/asm-commons.jar:$cache/asm-tree.jar" groovy.ui.GroovyMain \
  scripts/scheduling-contract/MonitorHarness.groovy "$work/monitor.gradle" \
  "$cache/react-android.jar" "$work/fixture/MonitorFixture.class"
java -cp "$work/fixture" MonitorFixture
echo 'LIMIT: RN dependency compilation, NDK ABI, R8, AAB inclusion and physical acceptance remain future artifact gates.'
