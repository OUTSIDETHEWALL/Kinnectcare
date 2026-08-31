---
name: PR verification rule
description: Required post-create check before announcing a PR to the user.
---

# PR Verification Rule

After creating a pull request, always verify the URL resolves before reporting it.

## The rule

1. Push branch → `gitPush()`
2. Create PR → `createPullRequest()`
3. **Verify** → `curl -s -o /dev/null -w "%{http_code}" "https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/<N>"`
4. Only report if HTTP 200. Report: PR number, URL, branch name, commit SHA.

**Why:** `createPullRequest()` returns success text but the PR may be already merged/closed, misreported, or creation may have silently failed. GitHub returns 200 for both open and merged PRs at the HTML URL — so a 200 confirms existence regardless of state. Without this check, the agent reports an "open" PR that the user cannot find because it is already merged or never existed.

**How to apply:** Every time a PR is created in this project, run the curl check as the final step before the user-facing summary. If the check fails (non-200), investigate before reporting.
