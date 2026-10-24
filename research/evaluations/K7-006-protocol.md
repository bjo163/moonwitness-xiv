# K7-006 local model evaluation protocol

This protocol separates measured model behavior from model-off application behavior. It uses only the exact source passages approved for the local pilot and synthetic graph records. Do not send private, restricted, or child-sensitive material to a model.

## Before a model run

Record the full source commit SHA, date, machine label, OS, CPU, installed memory, Node version, local model name and immutable model digest, quantization, runner version, context limit, and generation settings. Keep credentials, endpoint values, prompts containing secrets, and user data out of the report.

Choose one approved passage and freeze its source ID, edition ID, locator, full-source digest, Unicode-scalar range, and selected-span digest. Compare model variants only against this same passage and the same task prompt. Record each raw output privately for analysis; publish only aggregate measurements and sanitized examples. Run enough repetitions to report sample count and p50/p95 latency, plus peak resident memory if the runtime exposes a reliable measurement. Do not infer a score from a single response.

For each output, report schema acceptance, citation/source/span validation, exact extractive text acceptance where required, unsupported claim count, and whether any tool/action request appeared. A candidate counts as accepted only when the trusted resolver accepts it. The model never receives persistence, shell, network, publication, or canonical graph-write capabilities.

## Model-off and offline checks

With `AI_MODE` unset or `disabled`, verify the runtime returns `disabled` without invoking the provider transport. Verify API startup and at least one non-AI authenticated flow using a local database. For a separate egress-denied run, deny outbound network at the OS/container boundary, leave only any explicitly required loopback model endpoint reachable, and confirm the non-AI flow still succeeds. Record the enforcement mechanism and the exact test command; a mocked fetch assertion alone is not an OS-level egress-denial test.

## Reporting rules

Use `not measured` when a model or trustworthy metric source is unavailable. Do not substitute mocked timings for model latency or estimate memory from model file size. Keep source-coverage claims limited to passages actually tested. A model comparison is incomplete until all variants use the same passage, prompt, settings, and validation rules.
