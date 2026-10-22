"""Inspect debug-compiled application/registration/vendor hooks, not source strings."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--validation", type=pathlib.Path, required=True)
    args = parser.parse_args()
    validation = args.validation.resolve()
    project = validation / "evidence-candidate/frontend"
    module = project / "modules/startup-diagnostics/android/build/tmp/kotlin-classes/debug/expo/modules/startupdiagnostics"
    app = project / "android/app/build"
    geo = project / "node_modules/react-native-background-geolocation/android/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes/com/transistorsoft/rnbackgroundgeolocation"
    fetch = project / "node_modules/react-native-background-fetch/android/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes/com/transistorsoft/rnbackgroundfetch"
    expo = project / "node_modules/expo/android/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes/expo/modules"
    groups = {
        "application": [app / "tmp/kotlin-classes/debug/app/kinnship/client/MainApplication.class"],
        "react_registration": [app / "intermediates/javac/debug/compileDebugJavaWithJavac/classes/com/facebook/react/PackageList.class"],
        "expo_registration": list(expo.glob("ExpoModulesPackageList*.class")),
        "module": list(module.glob("StartupDiagnosticsModule*.class")),
        "observer": list(module.glob("EvidenceTrace*.class")) + list(module.glob("EvidenceStore*.class")),
        "http": list(module.glob("NativeHttpEvidence*.class")),
        "claim": list(module.glob("TrackingReliability*.class")),
        "geo_wake": list(geo.glob("HeadlessTask*.class")),
        "geo_position": list(geo.glob("RNBackgroundGeolocationModule*.class")),
        "geo_bridge": [geo / "KinnshipEvidenceBridge.class"],
        "fetch": list(fetch.glob("HeadlessTask*.class")) + [fetch / "KinnshipEvidenceBridge.class"],
    }
    expected = {
        "application": ["NativeHttpEvidence.install", "ReactNativeApplicationEntryPoint.loadReactNative"],
        "react_registration": ["rnbackgroundgeolocation/RNBackgroundGeolocation", "rnbackgroundfetch/RNBackgroundFetchPackage"],
        "expo_registration": ["expo/modules/startupdiagnostics/StartupDiagnosticsModule"],
        "module": ["evidenceVersion", "evidenceRecord", "evidenceRead", "trackingClaimEvidence",
                   "EvidenceTrace.record", "EvidenceTrace.read", "TrackingReliability.claim"],
        "observer": ["ArrayBlockingQueue", "kinnship_bounded_evidence_v2", "AtomicFile", "queueDropped",
                     "observer_busy_or_unavailable", "counter_overflow"],
        "http": ["setCustomClientBuilder", "native_call_start", "dispatcher_entered", "dns_start", "dns_end",
                 "connect_start", "connect_end", "connect_failed", "tls_start", "tls_end", "connection_acquired",
                 "request_headers_start", "request_headers_end", "request_body_start", "request_body_end",
                 "response_headers_start", "response_headers_end", "response_body_start", "response_body_end",
                 "native_call_end", "native_call_failed", "declined_existing_custom_builder",
                 "EventListener.cacheHit", "EventListener.proxySelectStart"],
        "claim": ["EvidenceTrace.record", "claim_decision", "configuration_claim_decision",
                  "revoked", "generation_mismatch", "owner_mismatch", "mutation_pending", "shutdown_pending",
                  "lease_active", "backoff", "capture_recent"],
        "geo_wake": ["native_wake_received", "native_task_queued", "native_context_requested", "native_context_ready",
                     "native_task_invoke", "native_task_finished", "native_task_error", "kcEvidenceWakeId",
                     "HeadlessJsTaskContext.startTask", "KinnshipEvidenceBridge.record"],
        "geo_position": ["native_gps_requested", "gps_callback_received", "gps_callback_failed",
                         "native_wake_received", "KinnshipEvidenceBridge.positionId", "KinnshipEvidenceBridge.record"],
        "geo_bridge": ["expo.modules.startupdiagnostics.EvidenceTrace", "getMethod", "java/lang/reflect/Method.invoke",
                       "kc_evidence_id", "kcEvidenceWakeId"],
        "fetch": ["native_wake_received", "native_task_queued", "native_context_requested", "native_task_skipped",
                  "native_task_invoke", "native_task_finished", "native_task_error", "kcEvidenceWakeId",
                  "HeadlessJsTaskContext.startTask", "KinnshipEvidenceBridge.record"],
    }
    manifest = {"scope": "debug .class call paths; NOT DEX, release shrinker, installed or physical execution",
                "groups": {}, "sources": {}}
    with zipfile.ZipFile(validation / "evidence-compiled-hooks.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for name, files in groups.items():
            assert files and all(file.is_file() for file in files), (name, "missing compiled classes")
            output = subprocess.check_output(["javap", "-c", "-p", *map(str, sorted(files))], text=True)
            (validation / f"evidence-bytecode-{name}.txt").write_text(output)
            for hook in expected[name]:
                assert hook in output, (name, "missing compiled hook", hook)
            if name == "application":
                body = output[output.index("public void onCreate()"):]
                assert body.index("NativeHttpEvidence.install") < body.index("ReactNativeApplicationEntryPoint.loadReactNative")
            manifest["groups"][name] = {
                "hooks": expected[name],
                "classes": {str(file.relative_to(project)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(files)},
            }
            for file in sorted(files):
                archive.write(file, name + "/" + file.name)
    # Ensure source being reviewed equals the isolated source actually compiled.
    root = pathlib.Path(__file__).resolve().parents[1] / "frontend"
    source_paths = list((root / "modules/startup-diagnostics/android").rglob("*.kt"))
    source_paths += [root / "modules/startup-diagnostics/android/build.gradle",
                     root / "modules/startup-diagnostics/android/consumer-rules.pro",
                     root / "plugins/withAndroidStartupRecorder.js", root / "plugins/withAndroidEvidenceTracing.js"]
    source_paths += [root / "src" / name for name in (
        "evidenceTrace.ts", "startupApiTiming.ts", "api.ts", "androidLocationAcquisition.ts",
        "batteryTask.ts", "trackingReliability.ts", "locationEngine.ts", "diagnosticsFull.tsx",
    )]
    for source in source_paths:
        relative = source.relative_to(root)
        assert source.read_bytes() == (project / relative).read_bytes(), ("compiled source drift", relative)
        manifest["sources"][str(relative)] = hashlib.sha256(source.read_bytes()).hexdigest()
    manifest["archiveSha256"] = hashlib.sha256((validation / "evidence-compiled-hooks.zip").read_bytes()).hexdigest()
    (validation / "evidence-compiled-hooks.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"COMPILED_HOOKS_PASS groups={len(groups)} classes={sum(len(v) for v in groups.values())}")
    print("debug_archive_sha256=" + manifest["archiveSha256"])


if __name__ == "__main__":
    main()
