#!/usr/bin/env bash
# Partial native validation, NOT an Android app build or device test.
set -euo pipefail
cd "$(dirname "$0")/.."
work="$(mktemp -d /tmp/kinnship-native-contract.XXXXXX)"
trap 'rm -rf "$work"' EXIT
curl -fLsS https://repo.maven.apache.org/maven2/com/google/android/android/4.1.1.4/android-4.1.1.4.jar -o "$work/android.jar"
curl -fLsS https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar -o "$work/json.jar"
classpath="$work/android.jar:$work/json.jar"
kotlinc -classpath "$classpath" \
  modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/TrackingReliability.kt \
  -d "$work/tracking.jar"
echo "PASS production TrackingReliability.kt compilation against Android API"
mkdir "$work/substitutes"
javac -classpath "$work/android.jar" -d "$work/substitutes" scripts/native-contract/*.java
runtime="$work/substitutes:$classpath:$work/tracking.jar"
kotlinc -classpath "$runtime" scripts/native-contract/TrackingHarness.kt -d "$work/harness.jar"
for stage in seed recreate; do
  kotlin -classpath "$runtime:$work/harness.jar" TrackingHarnessKt "$work/state.properties" "$stage"
done
echo "LIMIT: fake storage/clock; Expo app, ReactHost, chooser, Android scheduling NOT verified"
