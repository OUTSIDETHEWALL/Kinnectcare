---
name: Git push in Replit
description: How to push local commits to GitHub from the Replit workspace when the built-in credential helper is broken.
---

## The rule
Use `GITHUB_PAT` (stored as a Replit secret) with the `x-access-token` URL scheme — not the Replit built-in git credential helper.

## Why
The Replit git-proxy credential helper consistently times out (15+ seconds, every retry) in this project's environment. The error it returns — "password=GitHub token request timed out" — is a literal error string, not a token; GitHub rejects it with "Invalid username or token".

## How to apply
```bash
git remote set-url origin "https://x-access-token:${GITHUB_PAT}@github.com/OUTSIDETHEWALL/Kinnectcare.git"
git push origin main
git remote set-url origin "https://github.com/OUTSIDETHEWALL/Kinnectcare.git"
```

Reset the remote URL immediately after the push so the plaintext token is never left in the remote config.

## Branch protection constraint
`main` is a protected branch — force-push is blocked even with the PAT. If the remote diverges (e.g., from a partial API push), do `git fetch origin && git merge origin/main --no-edit` first, then push normally.

## CodeExecution sandbox limitations (reference)
- `shellExec` with `maxOutputBytes` or `timeoutMs` params breaks silently (exit 1 for every call).
- `readFile` inside CodeExecution cannot reach `/home/runner/workspace` — returns `notFound`.
- `fs.readFile` via `import('node:fs/promises')` inside `"use impure"` also cannot reach the workspace, but **can** reach `/tmp`.
- Workaround: Python script (via regular ShellExec tool) writes a JSON manifest to `/tmp/`, impure function reads from `/tmp/` and calls `proxyFetch` to GitHub.
