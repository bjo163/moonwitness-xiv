# Local AI hardware survey

## Inventory — 2026-10-17

This survey records the local development workstation without storing its hostname, user name, device identifiers, or environment values.

| Item             | Observed value                                                |
| ---------------- | ------------------------------------------------------------- |
| Operating system | Windows 11 Enterprise, x64                                    |
| CPU              | AMD Ryzen 5 7500F, 6 physical cores / 12 logical processors   |
| System memory    | 31.6 GiB reported                                             |
| GPU              | NVIDIA GeForce GT 610; Windows reports 2.0 GiB adapter memory |
| System volume    | 118.3 GiB total, 6.2 GiB free at survey time                  |
| Node.js          | v26.5.0                                                       |

The Windows adapter-memory value is inventory metadata, not a benchmark of memory available to inference. Free space is a point-in-time reading and does not establish that a model artifact can be stored outside the repository.

## Model and endpoint state

- `packages/local-ai/model-registry.json` has `activeArtifactId: null` and zero artifacts.
- `AI_MODE` is unset and defaults to `disabled`; no `LOCAL_AI_ENDPOINT` is configured.
- No listener was present on common Ollama or LM Studio ports 11434 and 1234. This check does not prove that no other model runner or port exists.
- No model name, license, artifact digest, quantization, or model performance is claimed.

The modest reported GPU memory and 6.2 GiB free system storage are constraints for later model selection. The survey does not select or download a model. K7-002 remains partial until an eligible local artifact and license are selected, verified, and registered with its immutable SHA-256.
