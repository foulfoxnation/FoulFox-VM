---
name: App UI proxy Origin header 403
description: Why Llama Llama Studio (and any fox-entry.mjs app) white-screens with 403 on JS/CSS assets
---

## The rule

**Delete the `Origin` header in `app-ui.ts` before forwarding requests to app processes.**

## Why

Vite builds always emit `<script type="module" crossorigin src="...">`. Module scripts
with `crossorigin` cause the browser to send an `Origin` header on every subresource
request. The shell serves the page from its own origin (e.g. `http://localhost:8080`);
the app process's loopback port is different (e.g. `http://127.0.0.1:27106`).

`fox-entry.mjs` (and any app running in `AUTH_MODE=local`) has this guard:

```js
const allowedOrigins = new Set(["null", `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: "Cross-origin access denied" });
    return;
  }
  next();
});
```

`GET /` is a navigation request → no `Origin` → 200.  
`GET /assets/index-*.js` is a module subresource → `Origin: http://localhost:8080` → 403.

The proxy forwards all headers verbatim, so the app sees the shell's origin and rejects.

## How to apply

In `artifacts/api-server/src/routes/app-ui.ts`, after building `fwdHeaders`, add:

```ts
delete fwdHeaders["origin"];
```

CSRF protection for writes is already handled at the proxy layer by `originAllowed()`,
so stripping `Origin` upstream is safe. Fixed in the `fcc832f` commit.

## What NOT to do

- Do NOT try to fix this in fox-entry.mjs (pre-built zip, not our code).
- Do NOT add the shell origin to the app's allowedOrigins (we don't control that list).
- Do NOT assume 403 = file permissions — always check if `Origin` is the culprit first.
