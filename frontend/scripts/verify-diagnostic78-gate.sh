#!/usr/bin/env bash
# Explicit non-release verification. Never runs EAS or APK/AAB packaging tasks.
# Usage: bash scripts/verify-diagnostic78-gate.sh <generated-frontend> <ndk> <output>
# ICU discovery uses standard CMAKE_INCLUDE_PATH/CMAKE_LIBRARY_PATH when needed.
set -euo pipefail
cd "$(dirname "$0")/.."
generated="$(realpath "${1:?isolated generated frontend required}")"
ndk="$(realpath "${2:?NDK 27.1 required}")"
output="$(realpath -m "${3:?dedicated generated evidence output required}")"
test "$generated" != "$PWD"
test -n "${ANDROID_HOME:-}" || { echo 'ANDROID_HOME is required'; exit 1; }
mkdir -p "$output"
output="$(mktemp -d "$output/attempt.XXXXXX")"
echo "Diagnostic78 evidence: $output"
# A failed rerun must never leave an old successful manifest as its result.
trap 'rc=$?; result=FAIL; if [ "$rc" = 0 ]; then result=PASS; fi; printf "{\"result\":\"%s\",\"exitStatus\":%s}\n" "$result" "$rc" > "$output/gate-result.json"' EXIT
node scripts/verify-scheduling-compiled.js "$generated" --sources-only > "$output/source-manifest.json"
node scripts/verify-scheduling-prebuild.js > "$output/source-contracts.json"
npm test -- --runInBand --forceExit src/__tests__/schedulingTracing.test.ts \
  src/__tests__/schedulingCompileGate.test.ts > "$output/focused-jest.log" 2>&1
# Complete real dependency compilation, without packaging an app.
(
  cd "$generated/android"
  KINNSHIP_DIAGNOSTIC_BUILD=78 ./gradlew ':react-native:packages:react-native:ReactAndroid:compileReleaseKotlin' \
    ':react-native:packages:react-native:ReactAndroid:externalNativeBuildRelease' \
    ':app:transformReleaseClassesWithAsm' \
    ':app:mergeDexRelease' \
    ':app:createBundleReleaseJsAndAssets' \
    --no-daemon --max-workers=2 '-Dorg.gradle.jvmargs=-Xmx3g -XX:ActiveProcessorCount=4'
) > "$output/whole-rn.log" 2>&1
if grep -q 'Invalid stack map table' "$output/whole-rn.log"; then
  echo 'FAIL: AGP/D8 reported invalid transformed frames' >&2; exit 1
fi
node scripts/verify-scheduling-compiled.js "$generated" "$ndk" > "$output/compiled-manifest.json"
bash scripts/verify-scheduling-cold.sh > "$output/host-cold.log"
bash scripts/verify-scheduling-ndk.sh "$ndk" "$output/ndk" > "$output/ndk.log" 2>&1
bash scripts/verify-request-origins.sh > "$output/request-origin-contracts.log" 2>&1
bash scripts/verify-scheduling-tracing.sh > "$output/native-contracts.log" 2>&1
bash scripts/verify-scheduling-integration.sh > "$output/integration.log" 2>&1
node scripts/verify-scheduling-activation.js > "$output/activation.log"
echo 'PASS diagnostic78 native gate; delivered-artifact and physical acceptance remain separate.'
