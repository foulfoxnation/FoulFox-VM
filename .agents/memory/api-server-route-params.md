---
name: api-server route params typing
description: Why req.params is string | string[] in api-server routes and how to satisfy tsc
---

In the api-server Express setup, `req.params.<name>` is typed `string | string[]`
(a global augmentation — NOT the default `@types/express` `ParamsDictionary`,
which would give `string`). Passing `req.params.id` straight into a function that
expects `string` fails `tsc` with TS2345 "Argument of type 'string | string[]'
is not assignable to parameter of type 'string'".

**Why:** vm.ts compiles with a bare `const id = req.params.id` only because it
immediately calls `isValidVmId(id)`, a type guard (`id is string`) that narrows
the union — not because params are `string` there.

**How to apply:** in any new route, narrow or normalize the param before use —
either a type-guard validator returning `id is string`, or a tiny helper like
`Array.isArray(v) ? v[0] ?? "" : v ?? ""` (apps.ts uses `pathParam`). Don't
assume route params are already `string`.
