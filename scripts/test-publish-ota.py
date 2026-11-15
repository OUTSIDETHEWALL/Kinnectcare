"""Hermetic publisher tests: no GitHub, Expo, Railway, or real credentials."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "frontend/scripts/publish-ota.sh"
COMMIT, TREE = "1" * 40, "2" * 40
UNSET = object()


class PublishGuards(unittest.TestCase):
    def run_case(self, *, reviewed_runtime="1.3.1", android_runtime=UNSET,
                 top_runtime=UNSET, production_selector=UNSET,
                 real_config=False, **overrides):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            front = root / "frontend"
            (front / "scripts").mkdir(parents=True)
            shutil.copy(SOURCE, front / "scripts/publish-ota.sh")
            profile = {"channel": "production"}
            if production_selector is not UNSET:
                profile["env"] = {"KINNSHIP_DIAGNOSTIC_BUILD": production_selector}
            (front / "eas.json").write_text(json.dumps({"build": {"production": profile}}))
            (front / "plugins").mkdir()
            shutil.copy(SOURCE.parents[1] / "plugins/diagnosticBuild.js",
                        front / "plugins/diagnosticBuild.js")
            runtime = overrides.pop("CONFIG_RUNTIME", "1.3.1")
            android = {"package": "app.kinnship.client"}
            if android_runtime is not UNSET:
                android["runtimeVersion"] = android_runtime
            top = {"policy": "appVersion"} if top_runtime is UNSET else top_runtime
            (front / "app.config.js").write_text(
                f"const android={json.dumps(android)};"
                "const selector=process.env.KINNSHIP_DIAGNOSTIC_BUILD;"
                f"if(selector) android.runtimeVersion={json.dumps(runtime)}+'-diagnostic'+selector;"
                f"module.exports=()=>({{expo:{{android,version:{json.dumps(runtime)},"
                f"runtimeVersion:{json.dumps(top)}}}}});"
            )
            if real_config:
                shutil.copy(SOURCE.parents[1] / "app.config.js", front / "app.config.js")
                shutil.copy(SOURCE.parents[1] / "eas.json", front / "eas.json")
            (front / ".env.production").write_text(
                "EXPO_PUBLIC_BACKEND_URL=https://kinnectcare-production.up.railway.app\n"
            )
            env_module = front / "node_modules/@expo/env"
            env_module.mkdir(parents=True)
            (env_module / "index.js").write_text(
                "exports.parseProjectEnv=()=>({env:{EXPO_PUBLIC_BACKEND_URL:"
                "'https://kinnectcare-production.up.railway.app'}});"
            )
            bins = root / "bin"
            bins.mkdir()
            shim = """#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys
tool=pathlib.Path(sys.argv[0]).name
a=sys.argv[1:]; root=pathlib.Path(os.environ['FIXTURE'])
if tool=='git':
 if 'fetch' in a:
  p=root/'fetches'; n=int(p.read_text())+1 if p.exists() else 1; p.write_text(str(n))
  sys.exit(1 if os.getenv('FETCH_FAIL') or (os.getenv('FETCH_FAIL_SECOND') and n==2) else 0)
 if 'status' in a: print(os.getenv('DIRTY','')); sys.exit(1 if os.getenv('STATUS_FAIL') else 0)
 if '--abbrev-ref' in a: print(os.getenv('BRANCH','main')); sys.exit(0)
 if a[-1]=='HEAD^{tree}': print(os.getenv('TREE','2'*40)); sys.exit(0)
 if a[-1]=='origin/main': print(os.getenv('REMOTE','1'*40)); sys.exit(0)
 print('1'*40); sys.exit(0)
if tool=='curl':
 pathlib.Path(a[a.index('-o')+1]).write_text('{"ok":true}'); print('200',end=''); sys.exit(0)
if tool=='npx':
 with (root/'calls').open('a') as f: f.write(json.dumps(a)+'\\n')
 if 'channel:view' in a:
  name='other' if os.getenv('BAD_MAPPING') else 'production'
  print(json.dumps({'currentPage':{'name':'production','isPaused':False,
   'branchMapping':json.dumps({'version':0,'data':[{'branchId':'b','branchMappingLogic':'true'}]}),
   'updateBranches':[{'id':'b','name':name}]}})); sys.exit(0)
 assert a[:2]==['eas','update'],a
 assert '--platform' in a and a[a.index('--platform')+1]=='android',a
 assert a[a.index('--channel')+1]=='production',a
 if 'EXPECTED_PUBLISH_SELECTOR' in os.environ:
  assert os.getenv('KINNSHIP_DIAGNOSTIC_BUILD')==os.environ['EXPECTED_PUBLISH_SELECTOR']
 # Independently evaluate the target with the environment actually inherited
 # by the fake publisher, rather than echoing the reviewed runtime argument.
 target=subprocess.check_output(['node','-e',\"\"\"
  const a=require('./app.config.js')({config:{}}).expo;
  const r=Object.hasOwn(a.android,'runtimeVersion') ? a.android.runtimeVersion : a.runtimeVersion;
  process.stdout.write(typeof r==='string' ? r : r.policy==='appVersion' ? a.version : '');
 \"\"\"],cwd=root/'frontend',text=True)
 print(json.dumps([{'platform':'ios' if os.getenv('BAD_PLATFORM') else 'android',
   'branch':'production','runtimeVersion':os.getenv('BAD_RECEIPT_RUNTIME',target),'gitCommitHash':'3'*40 if os.getenv('BAD_RECEIPT_SOURCE') else '1'*40,
  'group':'11111111-1111-1111-1111-111111111111','id':'22222222-2222-2222-2222-222222222222'}]))
 sys.exit(0)
raise Exception((tool,a))
"""
            for tool in ["git", "curl", "npx"]:
                path = bins / tool
                path.write_text(shim)
                path.chmod(0o755)
            # Do not inherit real provider credentials or a developer's selector.
            env = {key: os.environ[key] for key in
                   ["HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"] if key in os.environ}
            env.update(PATH=f"{bins}:{os.environ['PATH']}", FIXTURE=tmp,
                       EXPO_TOKEN="test-fixture", **overrides)
            result = subprocess.run(
                ["bash", str(front / "scripts/publish-ota.sh"), "Test only",
                 COMMIT, TREE, reviewed_runtime],
                env=env, capture_output=True, text=True, timeout=15,
            )
            calls = [json.loads(x) for x in (root / "calls").read_text().splitlines()] \
                if (root / "calls").exists() else []
            return result, [x for x in calls if "update" in x]

    def test_exact_reviewed_android_release(self):
        result, updates = self.run_case()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(updates), 1)
        self.assertIn("No iOS update was published", result.stdout)

    def test_preflight_failures_never_publish(self):
        for case in [{"FETCH_FAIL": "1"}, {"FETCH_FAIL_SECOND": "1"},
                     {"REMOTE": "3" * 40}, {"TREE": "3" * 40},
                     {"BRANCH": "feature"}, {"DIRTY": " M file"},
                     {"STATUS_FAIL": "1"},
                     {"CONFIG_RUNTIME": "9.9.9"}, {"BAD_MAPPING": "1"}]:
            with self.subTest(case=case):
                result, updates = self.run_case(**case)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(updates, [])

    def test_unexpected_result_stops_without_retry(self):
        for case in [{"BAD_PLATFORM": "1"}, {"BAD_RECEIPT_SOURCE": "1"},
                     {"BAD_RECEIPT_RUNTIME": "wrong-native-runtime"}]:
            with self.subTest(case=case):
                result, updates = self.run_case(**case)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(updates), 1)
                self.assertIn("DO NOT republish", result.stdout)

    def test_android_string_override_takes_precedence(self):
        result, updates = self.run_case(
            android_runtime="android-native-runtime", reviewed_runtime="android-native-runtime")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(updates), 1)

    def test_android_app_version_policy_takes_precedence(self):
        result, updates = self.run_case(
            android_runtime={"policy": "appVersion"}, top_runtime="wrong-top-level")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(updates), 1)

    def test_top_level_string_fallback(self):
        result, updates = self.run_case(
            top_runtime="legacy-string-runtime", reviewed_runtime="legacy-string-runtime")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(updates), 1)

    def test_real_build81_config_and_publisher_receive_production_selector(self):
        result, updates = self.run_case(
            real_config=True, reviewed_runtime="1.3.1-diagnostic81",
            EXPECTED_PUBLISH_SELECTOR="81")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(updates), 1)
        self.assertIn("runtime 1.3.1-diagnostic81", result.stdout)

    def test_matching_shell_selector_is_allowed(self):
        result, updates = self.run_case(
            production_selector="81", KINNSHIP_DIAGNOSTIC_BUILD="81",
            reviewed_runtime="1.3.1-diagnostic81", EXPECTED_PUBLISH_SELECTOR="81")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(updates), 1)

    def test_legacy_profile_pins_empty_selector_for_publisher(self):
        result, updates = self.run_case(EXPECTED_PUBLISH_SELECTOR="")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(updates), 1)

    def test_build81_rejects_wrong_reviewed_runtime(self):
        for runtime in ["1.3.1", "1.3.1-diagnostic80"]:
            with self.subTest(runtime=runtime):
                result, updates = self.run_case(
                    production_selector="81", reviewed_runtime=runtime)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(updates, [])

    def test_conflicting_shell_selector_cannot_change_production_identity(self):
        result, updates = self.run_case(
            production_selector="81", KINNSHIP_DIAGNOSTIC_BUILD="80",
            reviewed_runtime="1.3.1-diagnostic80")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(updates, [])

    def test_shell_selector_cannot_override_legacy_production_profile(self):
        result, updates = self.run_case(
            KINNSHIP_DIAGNOSTIC_BUILD="81", reviewed_runtime="1.3.1-diagnostic81")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(updates, [])

    def test_invalid_production_selector_fails_before_publishing(self):
        for selector in [None, "", 81, "70", "81-extra", "99999999999999999999"]:
            with self.subTest(selector=selector):
                result, updates = self.run_case(production_selector=selector)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(updates, [])

    def test_invalid_android_runtime_never_falls_back_to_top_level(self):
        for runtime in ["", None, {"policy": "nativeVersion"}, {"policy": "fingerprint"}]:
            with self.subTest(runtime=runtime):
                result, updates = self.run_case(android_runtime=runtime)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(updates, [])


if __name__ == "__main__":
    unittest.main()
