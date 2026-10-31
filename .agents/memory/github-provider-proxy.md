---
name: GitHub provider proxy
description: How Replit's Git provider proxy differs from the GitHub API integration catalog.
---

Replit's Git pane can connect a GitHub repository through an internal Git provider host even while the separate GitHub API integration is not callable. Do not infer that the repository is unlinked from the integration catalog status alone. The internal remote is not the user's public URL; use authenticated repository metadata to confirm the actual GitHub URL and visibility.

**Why:** In this workspace, Git operations and the authenticated GitHub CLI worked through the provider proxy while the API integration catalog still reported `connect`.

**How to apply:** Check `git remote` for linkage, then use the existing authenticated GitHub CLI/API to inspect repository metadata. Never print authentication tokens. Verify public visibility against the actual GitHub URL, not the proxy host.
