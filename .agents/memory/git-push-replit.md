---
name: Git push in Replit
description: How to push local commits to GitHub from the Replit workspace when the built-in credential helper is broken.
---

## The rule
Try `GITHUB_PAT` (stored as a Replit secret) with the `x-access-token` URL scheme, not the built-in credential helper. If GitHub rejects that PAT, use the already-added GitHub connector's Git Data and Pull Request APIs; do not request a token from the user.

## Why
The Replit git-proxy credential helper consistently times out in this project, and the saved PAT can expire or be revoked independently. The authorized GitHub connector remains a credential-safe fallback that can create blobs, trees, commits, refs, and pull requests without exposing credentials.

## How to apply
```bash
git remote set-url origin "https://x-access-token:${GITHUB_PAT}@github.com/OUTSIDETHEWALL/Kinnectcare.git"
git push origin main
git remote set-url origin "https://github.com/OUTSIDETHEWALL/Kinnectcare.git"
```

Reset the remote URL immediately after the push so the plaintext token is never left in the remote config.

If the PAT is rejected, construct the remote commit from the local diff through the connector, then verify the remote branch tree and the public PR URL before reporting success.

## Branch protection constraint
`main` is a protected branch — force-push is blocked even with the PAT. If the remote diverges (e.g., from a partial API push), do `git fetch origin && git merge origin/main --no-edit` first, then push normally.

