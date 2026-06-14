---
name: GitHub push from a subrepl
description: How to push this project to a user's external GitHub repo when there is no Connect-to-GitHub UI.
---

# Pushing this project to GitHub from a subrepl

This project is a **subrepl** (its only git remotes are `gitsafe-backup` and
`subrepl`), so the Replit "Connect to GitHub / Create a GitHub repository" button
does **not** appear. To push to a user-owned GitHub repo, push by **direct URL**
with a credential helper that reads a PAT from the environment:

```bash
GIT_TOK="$SOME_TOKEN" git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GIT_TOK"; }; f' \
  push https://github.com/<owner>/<repo>.git HEAD:main
```

**Why:** the main agent is sandbox-blocked from destructive git — `git remote add`
and any `git config` write fail on `.git/config.lock`. A direct-URL push needs no
remote/config change, so it works. The agent's bash env *can* read secret values
by name, so a token stored in Secrets is usable inline like above.

**How to apply:**
- Token must be a **classic** PAT with `repo` (+ `workflow` if pushing Actions
  YAML) or an equivalent fine-grained token with Contents:write. Verify scopes
  first: `curl -sD- -o/dev/null -H "Authorization: Bearer $TOK" https://api.github.com/user | grep -i x-oauth-scopes`.
- Get the token via the **Secrets box** (`requestEnvVar`), never via chat — a token
  pasted in chat is exposed and must be revoked at github.com/settings/tokens.
- 401 on `/user` = invalid/expired token (or wrong value saved). 403 on push with a
  200 on `/user` = valid token but missing write scope.
- The main agent cannot `git commit`; working-tree changes are auto-committed only
  at task completion, so you can only push commits that already exist.
