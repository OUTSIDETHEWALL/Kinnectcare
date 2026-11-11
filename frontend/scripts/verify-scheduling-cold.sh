#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
work="$(mktemp -d /tmp/kinnship78-cold.XXXXXX)"
trap 'rm -rf "$work"' EXIT
wrap=()
for fn in malloc calloc realloc free pthread_mutex_lock pthread_once pthread_setspecific; do
  wrap+=("-Wl,--wrap=$fn")
done
g++ -std=c++20 -O2 -pthread scripts/scheduling-contract/ColdProducerHarness.cpp "${wrap[@]}" -o "$work/cold"
for mode in cold ready parallel reuse exhaustion; do timeout 60s "$work/cold" "$mode"; done
echo 'LIMIT: host threads/call interposition, not Android Bionic/JVM/physical-device acceptance'
