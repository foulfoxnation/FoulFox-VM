---
name: workflow_dispatch sha race after push
description: Dispatching a GitHub workflow seconds after a push can pin the PREVIOUS commit
---
A workflow_dispatch fired immediately after `git push` can resolve `ref: main` to the pre-push sha — the run then builds without the new commit.

**Why:** an app-bundle release build dispatched by the push script raced and built the prior commit; the fix commit was on main but not in the artifact.

**How to apply:** after dispatch, check the run's `head_sha` against the pushed commit. If they differ, dispatch again (a duplicate publish_release run is harmless — latest release wins).
