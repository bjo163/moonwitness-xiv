# Local AI evaluation status

## Model-off baseline — 2026-10-17

The runtime configuration defaults to `disabled` when `AI_MODE` is unset. The local `.env` is present, but no `LOCAL_AI_ENDPOINT` is configured; no endpoint value or other environment secret is included in this report. No model was loaded or called, and no user or private data was sent.

The model-off checks passed on the MoonWitness local development workstation: Windows 11 Enterprise x64, AMD Ryzen 5 7500F, 31.6 GiB reported memory, and Node.js v26.5.0. The package test injects a transport spy and confirms that the disabled runtime makes zero provider calls. The API authentication integration test starts the app with its seeded SQLite fixture and confirms the runtime remains disabled. A container smoke built the current API and Board images, started an ephemeral PostgreSQL 16 service, verified Docker reported `Internal=true` for the runtime network before API startup, and passed the API, approved local corpus, Board, and graceful-shutdown checks from inside the API container. The smoke removed its own project containers, network, and volumes afterward. This verifies the configured Docker runtime network policy; it does not attempt a live outbound request, and image builds/package retrieval occur before runtime startup.

Checks run:

- `pnpm --filter @moonwitness/local-ai exec vitest run tests/runtime.test.ts -t "defaults to disabled and makes no provider request"` — 1 passed.
- `pnpm --filter @moonwitness/api exec vitest run tests/auth.test.ts -t "starts with AI disabled and makes no provider call"` — 1 passed; 42 unrelated tests skipped.
- `node scripts/smoke-containers.mjs` — passed with current working-tree images and the smoke Compose internal network.

Model latency, peak memory, source coverage, and same-source model comparison are **not measured** because no local model endpoint or model identity is configured. No score is claimed. To complete this part, configure a named local model and immutable model digest, then follow the [K7-006 evaluation protocol](../../research/evaluations/K7-006-protocol.md) on the same approved passage and record model-specific results.

This report is a local model-off baseline only. It does not certify model quality, production resilience, or release readiness.
