# Local AI hardware and model artifact inventory

Surveyed 2026-10-16 on the local development host. This is a capacity snapshot,
not a production benchmark or a compatibility promise.

| Resource         |                                  Observed capacity | Interpretation                                                                |
| ---------------- | -------------------------------------------------: | ----------------------------------------------------------------------------- |
| CPU              | AMD Ryzen 5 7500F, 6 cores / 12 logical processors | CPU execution is available; no model throughput benchmark was run.            |
| System memory    |                                           31.6 GiB | OS-reported physical memory; runtime and other applications also consume it.  |
| GPU              |                              NVIDIA GeForce GT 610 | Legacy display adapter; no supported inference runtime was verified.          |
| Adapter memory   |                          2 GiB reported by Windows | `AdapterRAM` is an OS-reported value, not a verified usable-VRAM measurement. |
| Workspace volume |                     238.5 GiB total, 31.8 GiB free | Not a model storage location; model files must remain outside the checkout.   |
| System volume    |                     118.3 GiB total, 10.6 GiB free | Avoid storing model weights here without an explicit operator decision.       |

## Model registry and storage policy

[`packages/local-ai/model-registry.json`](../../../packages/local-ai/model-registry.json)
intentionally has no active artifact and an empty artifact list. The workspace
scan found no `.gguf`, `.safetensors`, `.onnx`, `.pt`, or `.bin` model files in
the project. No model was downloaded or selected, so this inventory makes no
source-license, model-hash, or performance claim for a real model. A model is
never required to run the API or worker.

When an operator later selects a model, store it outside the Git worktree,
preferably under `%LOCALAPPDATA%\MoonWitness\models` on Windows or the platform's
user data directory. Add its HTTPS source, reviewed license reference, version,
relative filename, SHA-256, byte length, and minimum RAM/VRAM profile to the
registry. The `verifyLocalModelArtifact` helper rejects paths inside the
worktree, symbolic-link traversal, unreviewed licenses, missing files, and
checksum/size mismatches. No downloader is provided; acquisition and rights
review remain explicit operator actions.

This profile does not establish that the GT 610 can run an inference backend.
Benchmark and compatibility evidence must be recorded per model/runtime in a
future update before enabling `AI_MODE=local` for a real workload.
