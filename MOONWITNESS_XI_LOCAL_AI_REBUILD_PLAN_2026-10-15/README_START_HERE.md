# MOONWITNESS XI — START HERE

This handoff package is retained as the source planning artifact for the K-series roadmap. Repository copies are registered under `docs/roadmap/12-local-ai-rebuild.md`; the original task scope and its independent review gates remain explicit.

## Files

1. **`MOONWITNESS_XI_MASTER_PLAN.md`** — architecture constitution, legacy findings, data/corpus/ontology contracts, local AI security, sequence, golden tests, release criteria.
2. **`MOONWITNESS_XI_TASKS.json`** — 65 dependency-checked work items with title, file scope, dependencies, deliverable, acceptance, verification, risk, and planned status.
3. **`MOONWITNESS_XI_BACKLOG.md`** — same work items in a human-readable issue-ready index.
4. **`LOCAL_AI_EXECUTION_RUNBOOK.md`** — strict operating instructions and starter prompt for the local coding agent.
5. **`SHA256SUMS.txt`** — checksums for this package's four substantive files; hashes were refreshed after repository Prettier formatting.

## How to proceed

1. Read master plan and the existing repository governance docs; do not assume this proposal overrides accepted XI ADRs.
2. Operator copies the bundle contents into a **local workspace** of `bjo163/moonwitness-xi` (for example under `docs/planning/local-rebuild/`), without adding private data.
3. Agent performs read-only baseline and prepares **K0-001** ADR proposal; operator reviews and approves as appropriate.
4. Only then implement planned tasks in dependency order. Use existing `dev` branch and PR promotion to `main`; no cloud LLM and no mandatory runtime LLM.
5. Do not open all 65 GitHub issues at once. Pilot an initial K0 batch through XI's existing task/issue planner and permission gates; the JSON itself does not create issues.

## What was not done

- No commit, issue, pull request, production release or deployment was created.
- No complete ChatGPT-account export was retrieved or imported.
- No full legacy corpus was copied; copyright/privacy gates remain pending.
- No local hardware benchmark or new test suite was executed on the user's computer.

Document version: `v1.0 planning baseline`, 2026-10-15.
