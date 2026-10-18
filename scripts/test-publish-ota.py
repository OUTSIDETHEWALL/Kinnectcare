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


class PublishGuards(unittest.TestCase):
    def run_case(self, **overrides):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            front = root / "frontend"
            (front / "scripts").mkdir(parents=True)
            shutil.copy(SOURCE, front / "scripts/publish-ota.sh")
            (front / "eas.json").write_text('{"build":{"production":{"channel":"production"}}}')
            runtime = overrides.pop("CONFIG_RUNTIME", "1.3.1")
            (front / "app.config.js").write_text(
                "module.exports=()=>({expo:{android:{package:'app.kinnship.client'},"
                f"version:'{runtime}',runtimeVersion:{{policy:'appVersion'}}}}}});"
            )
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
import json,os,pathlib,sys
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
 assert '--platform' in a and a[a.index('--platform')+1]=='android',a
 print(json.dumps([{'platform':'ios' if os.getenv('BAD_PLATFORM') else 'android',
  'branch':'production','runtimeVersion':'1.3.1','gitCommitHash':'3'*40 if os.getenv('BAD_RECEIPT_SOURCE') else '1'*40,
  'group':'11111111-1111-1111-1111-111111111111','id':'22222222-2222-2222-2222-222222222222'}]))
 sys.exit(0)
raise Exception((tool,a))
"""
            for tool in ["git", "curl", "npx"]:
                path = bins / tool
                path.write_text(shim)
                path.chmod(0o755)
            env = dict(os.environ, PATH=f"{bins}:{os.environ['PATH']}",
                       FIXTURE=tmp, EXPO_TOKEN="test-fixture", **overrides)
            result = subprocess.run(
                ["bash", str(front / "scripts/publish-ota.sh"), "Test only",
                 COMMIT, TREE, "1.3.1"],
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
        for case in [{"BAD_PLATFORM": "1"}, {"BAD_RECEIPT_SOURCE": "1"}]:
            with self.subTest(case=case):
                result, updates = self.run_case(**case)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(updates), 1)
                self.assertIn("DO NOT republish", result.stdout)


if __name__ == "__main__":
    unittest.main()
