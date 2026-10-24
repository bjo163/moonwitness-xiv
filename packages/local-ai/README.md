# `@moonwitness/local-ai`

Optional AI runtime adapter. The default `AI_MODE=disabled` returns a typed
disabled result without network access. `AI_MODE=local` requires an explicit
`LOCAL_AI_ENDPOINT` using HTTP on `localhost`, `127.0.0.1`, or `::1`; remote
hosts, redirects, credentials, query strings, and fragments are rejected.

The adapter uses a bounded request timeout and a small JSON contract:

```json
{ "prompt": "synthetic prompt" }
```

The local provider responds with `{ "text": "..." }`. Provider errors and
timeouts return typed unavailable results. There is no cloud provider, remote
fallback, background transmission, or automatic retry. Prompts must be supplied
by an explicit caller; this package does not collect or persist them. Output is
untrusted suggestion text and must never directly mutate canonical records or
publish content.
