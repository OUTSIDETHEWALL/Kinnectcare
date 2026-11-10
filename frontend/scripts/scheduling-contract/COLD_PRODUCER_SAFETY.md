# Build 78 cold producer state

## Inspection before correction

`Local` previously used C++ `thread_local`:
- Four nested registration scopes join real native timer creation/admission to
  immutable request, operation, flight, JS-runtime and registration identifiers.
- The current C++ runtime ID follows execution across native/JS observations.
- Nested hold depth and 32 primitive scratch events defer ingress until the
  original RN monitor invocation returns, including exceptional returns.
- Host cause/serial correlate host listener entry to its frame-control calls.

These are per-caller execution semantics, not a requirement to allocate storage
in a language TLS runtime. The affected paths include hold/release, begin/end,
scope/publish, host/frame observations, progress and C++ runtime-executor guards.
The original Android builds imported `__emutls_get_address` and emitted
`__emutls_v/_t` controls for Local. Android compiler/runtime disassembly exposed
allocator, pthread-once and locking paths. UI-thread warming was insufficient.

## Correction

There are 64 fixed contexts plus atomic ownership words, **501,760 bytes total**
on the measured host. NDK C++20 `constinit` enforces static initialization.
No function-local static, growable container, thread attachment, lookup cache,
worker, Looper, disk, log or allocation is introduced.

An existing OS thread identity is read from its hardware thread register (on
x86, the existing TCB self pointer). No observer data is placed in that TCB.
Android JVM/pthread/native runtime callers already have this identity before
user callbacks execute. ARMv7 uses an explicit register read so even the
out-of-line `__aeabi_read_tp` helper is unnecessary.

Ownership lookup/claim is bounded by two 64-entry scans, with one nonwaiting CAS
per candidate. This is not a mutex: other threads never wait for an occupied
context. Ownership persists while a hold, registration, runtime, host cause or
nested borrow is live. An idle context is released with acquire/release ordering
so normal thread/TCB reuse cannot inherit another caller's state. Producer
scopes continue to pair through the existing C++ RAII and Java/JS finally paths.
The consumer never owns, locks or drains these caller contexts.

The four-entry registration stack, 32-event scratch, runtime nesting/restoration,
binding IDs and marker timestamps remain. Host cause values are opaque IDs;
per-slot monotonic serial plus slot index keeps them unique across slot reuse.
Cross-JNI host/frame cause continuity and cleanup are tested.

If no context can be acquired, observation explicitly closes until process
recreation. `contextClosed`, `contextLoss`, `contextExhaustions` and capacity are
exported and persisted. Existing trustworthy evidence remains readable.
This conservative failure is intentional: if an OUTER hold was missed, a later
inner event must not grab a newly free context and publish as though no vendor
monitor were held. There is no waiting, allocation or unguarded fallback.
Applications keep running; diagnostic coverage becomes explicitly unknown.

## Evidence and boundaries

- `verify-scheduling-cold.sh`: fresh host processes, genuinely new real threads,
  critical-path malloc/calloc/realloc/free, mutex, once and thread-specific setter
  call interposition; held application mutex, nested guards, concurrent distinct
  request contexts, 1,000 create/reuse cycles and full-capacity failure.
- `verify-scheduling-ndk.sh`: actual NDK 27.1 machine code for all four ABIs;
  fresh QEMU process per early/runtime/held/publish/exhaustion scenario. No
  corrected-state warmup. The image has no dynamic loader, allocator, pthread,
  C++ library, JNI, worker or TLS runtime and no initializer array/guard.
  Actual compiler-rt outlined-atomic assembly is linked. ARM64 LL/SC and LSE
  paths run separately. Unsafe TLS negative controls are rejected on every ABI.
- QEMU tests adapt OS-thread-register bootstrap, CPU feature selection and clocks.
  They do not execute Android Bionic/JVM or establish physical scheduling safety.
- Production JNI/file/export tests preserve the six fetch/abort witnesses over
  simulated 46-minute delay, late completion, 3,000-request flood and fresh-JVM
  restore. Separate tests persist capacity-failure status.

Workspace QEMU is verification tooling only, not an Android app dependency.
Whole-RN source compile/transform completion, delivered `.so`/DEX inspection and
physical Android acceptance remain separate gates. Removing this TLS blocker is
not permission to build an AAB.
