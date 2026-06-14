---
name: noVNC + Vite CJS top-level-await pitfall
description: Why noVNC must be pinned to 1.4.0's ESM core/ build in this Vite app
---
noVNC 1.5.0 and 1.6.0 npm tarballs ship ONLY a Babel-compiled CommonJS `lib/` build, and `lib/util/browser.js` contains a top-level `await` (a WebCodecs H264 capability probe). Vite/esbuild dependency optimization then fails hard at dev-server startup with: "This require call is not allowed because the imported file contains a top-level await" — because a CommonJS `require()` cannot import an async (TLA) module. This crashes the ENTIRE web workflow, not just the VNC view.

Fix: pin `@novnc/novnc` to `1.4.0` (exact), which ships the ESM `core/` build alongside `lib/`. Import `RFB` from `@novnc/novnc/core/rfb.js` (ESM → esbuild allows TLA), add `optimizeDeps.include: ["@novnc/novnc/core/rfb.js"]` in vite.config, and declare an ambient module for that exact import path (the package ships no bundled types). The RFB surface we use (scaleViewport / resizeSession / background, and connect/disconnect/securityfailure events) is identical across these versions.

**Why:** 1.5+ dropped the ESM `core/` directory from the published tarball; only 1.4.0 and earlier ship it.
**How to apply:** if anyone bumps noVNC and the web workflow dies with an esbuild top-level-await error, this is the cause — stay on 1.4.0 `core/`, or supply a prebuilt ESM bundle.
