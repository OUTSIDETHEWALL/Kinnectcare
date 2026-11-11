#!/usr/bin/env bash
# Four-ABI native compile and cold-producer disassembly. NO APK/AAB.
# Usage: bash scripts/verify-scheduling-ndk.sh /path/to/android-ndk-r27b /output
set -euo pipefail
cd "$(dirname "$0")/.."
ndk="$(realpath "${1:?NDK path required}")"
output="$(realpath -m "${2:?Dedicated generated output directory required}")"
mkdir -p "$output"
llvm="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin"
grep -q '27.1.12297006' "$ndk/source.properties"
unsafe=0
for abi in aarch64-linux-android24 armv7a-linux-androideabi24 x86_64-linux-android24 i686-linux-android24; do
  "$llvm/$abi-clang++" -std=c++20 -O2 -shared -fPIC -pthread -x c++ \
    -Imodules/startup-diagnostics/native modules/startup-diagnostics/native/SchedulingJni.h \
    -o "$output/$abi.so"
  "$llvm/llvm-nm" -D "$output/$abi.so" | grep 'SchedulingBridge_beginNative'
  "$llvm/llvm-objdump" --disassemble-symbols=Java_com_facebook_react_runtime_SchedulingProbe_holdNative \
    "$output/$abi.so" > "$output/$abi-first-hold.txt"
  "$llvm/llvm-nm" -D "$output/$abi.so" > "$output/$abi-symbols.txt"
  echo "PASS Android NDK 27.1 compile/link: $abi"
  # ARM32 objdump can label PLT branches as strlen+offset rather than resolving
  # the imported target name. Do NOT turn that display limitation into a PASS.
  # This SO contains only the added diagnostic core/JNI, not unrelated RN code.
  if grep -q '__emutls_get_address' "$output/$abi-symbols.txt"; then
    echo "FAIL cold producer: $abi added diagnostic TLS uses allocating emulation"
    unsafe=$((unsafe + 1))
    continue
  fi
  # Ensure the check rejects the original unsafe mechanism under these flags.
  "$llvm/$abi-clang++" -std=c++20 -O2 -shared -fPIC \
    scripts/scheduling-contract/UnsafeTlsControl.cpp -o "$output/$abi-unsafe-control.so"
  "$llvm/llvm-nm" -D "$output/$abi-unsafe-control.so" > "$output/$abi-unsafe-symbols.txt"
  grep -q '__emutls_get_address' "$output/$abi-unsafe-symbols.txt"
  echo "PASS negative control: $abi unsafe per-thread allocation rejected"
  # Execute target code without allocator, pthread, C++ library runtime, Bionic
  # or dynamic loader. Only actual compiler-rt atomic assembly is linked.
  "$llvm/$abi-clang++" -std=c++20 -O2 -fno-exceptions -fno-rtti \
    -fno-stack-protector -fomit-frame-pointer -fno-builtin -nostdlib -static \
    -Wl,--no-dynamic-linker,-e,_start,-no-pie \
    scripts/scheduling-contract/ColdAbiHarness.cpp \
    "$("$llvm/$abi-clang++" --print-libgcc-file-name)" -o "$output/$abi-cold"
  "$llvm/llvm-readelf" -a "$output/$abi-cold" > "$output/$abi-cold-elf.txt"
  if grep -Eq '__emutls|__tls_get_addr|__cxa_guard|INIT_ARRAY|NEEDED|INTERP' "$output/$abi-cold-elf.txt"; then
    echo "FAIL $abi: cold executable has forbidden initialization/runtime support"
    unsafe=$((unsafe+1)); continue
  fi
  case "$abi" in
    aarch64*) runner=qemu-aarch64;;
    armv7*) runner=qemu-arm;;
    x86_64*) runner=qemu-x86_64;;
    i686*) runner=qemu-i386;;
  esac
  command -v "$runner" >/dev/null # never silently skip an unexecuted ABI
  for scenario in early runtime held publish exhaustion; do
    timeout 20s "$runner" "$output/$abi-cold" "$scenario"
  done
  if [[ "$abi" == aarch64* ]]; then
    timeout 20s "$runner" -cpu max "$output/$abi-cold" lse
    echo "PASS aarch64 outlined atomics: both LL/SC and LSE paths executed cold"
  fi
  echo "PASS cold native execution: $abi (5 fresh-process scenarios; no replacement-state warming)"
done
lib="$ndk/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so"
"$llvm/llvm-objdump" --disassemble-symbols=__emutls_get_address "$lib" > "$output/emutls-runtime.txt"
echo "NDK compile/link: 4 passed. Cold producer ABI checks: $unsafe failed."
echo 'LIMIT: freestanding NDK code under QEMU with OS-thread/clock adapters; not Bionic/JVM or physical Android proof.'
test "$unsafe" -eq 0
