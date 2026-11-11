#!/usr/bin/env bash
# Real producer JNI and production persistence pipeline; no APK/AAB/EAS.
set -euo pipefail
cd "$(dirname "$0")/.."
cache=/tmp/kinnship-origin-compile
work="$(mktemp -d /tmp/kinnship78-integration.XXXXXX)"
trap 'rm -rf "$work"' EXIT
test -f "$cache/react-android.jar" || { echo 'Run verify-request-origins.sh first'; exit 1; }
cp="$cache/json.jar:$cache/android-api19-surface.jar:$cache/okhttp.jar:$cache/okio.jar:$cache/react-android.jar"
javahome="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
g++ -std=c++17 -O2 -shared -fPIC -pthread -I"$javahome/include" -I"$javahome/include/linux" \
  scripts/scheduling-integration/IntegrationDriver.cpp -o "$work/libintegration.so"
mkdir -p "$work/classes"
javac --release 17 -cp "$cp" -d "$work/classes" scripts/origin-contract/{Context,Looper,HandlerThread,Handler,SystemClock}.java \
  scripts/scheduling-integration/{Application,Activity,ActivityManager}.java
node - "$work/SchedulingProbe.kt" <<'JS'
require('fs').writeFileSync(process.argv[2], require('./plugins/schedulingHooks').javaProbe);
JS
native=modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics
kotlinc -classpath "$work/classes:$cp" \
  "$native/DeepAsyncTrace.kt" "$native/RecorderWorker.kt" "$native/RecorderMap.kt" \
  "$native/SchedulingBridge.kt" "$native/SchedulingTrace.kt" "$native/SchedulingRetention.kt" \
  "$work/SchedulingProbe.kt" scripts/scheduling-integration/IntegrationHarness.kt -d "$work/integration.jar"
runtime="$work/classes:$work/integration.jar:$cp"
timeout 90s kotlin -classpath "$runtime" IntegrationHarnessKt "$work/state" seed "$work/libintegration.so"
timeout 30s kotlin -classpath "$runtime" IntegrationHarnessKt "$work/state" restore
timeout 30s kotlin -classpath "$runtime" IntegrationHarnessKt "$work/disabled" disabled
timeout 30s kotlin -classpath "$runtime" IntegrationHarnessKt "$work/exhaustion" exhaustion "$work/libintegration.so"
