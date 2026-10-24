# WhatsApp service migration: Baileys to whatsmeow

## Objective

Replace the TypeScript Baileys transport in `apps/whatsapp` with a Go service using `go.mau.fi/whatsmeow`, while keeping the authenticated Board and API contract, the PostgreSQL-backed outbox/inbox, one WhatsApp device per company, media handling, and safe retries. Deliver a runnable service, migration notes, test evidence, and a small-task checklist.

## Architecture decisions

- Keep the service boundary and HTTP health endpoint at `apps/whatsapp`; implement the process in Go so existing root `pnpm dev`, `pnpm start`, and Compose commands still start it.
- Keep the API as the only Board-facing/authenticated boundary. Continue using internal HTTP for account control, QR/status, inbound events, delivery receipts, and outbox claims/results.
- Use whatsmeow's PostgreSQL SQL store for device identity and Signal/session material. Add an explicit account-to-device mapping and a single-process lease so two workers cannot own one linked device.
- Existing Baileys auth material cannot be imported as a whatsmeow device. Keep it untouched until the new device is paired and verified; then offer a deliberate cleanup path. A new QR scan is expected.
- Wrap whatsmeow SQLStore with AES-256-GCM at the SQL driver boundary. Encrypt secret bytea fields before PostgreSQL writes, retain only lookup/index bytes required for SQL equality, migrate existing plaintext values on startup, and require a stable `WHATSAPP_SESSION_KEY` in production. Database and backup encryption remain required for other application data.
- Preserve current per-message text/media and private/group behavior. Status/Story is a separate experimental follow-up and is not silently enabled by this transport migration.

## Separate follow-up: WhatsApp Status/Story

- [ ] Inspect the pinned whatsmeow version's status send/read/viewer receipt APIs and limitations.
- [ ] Add fake-client tests for create, media upload, audience selection, result/error mapping, and status event ingestion.
- [ ] Decide Board scope: view statuses, publish text/image/video, choose audience, and inspect viewers/receipts.
- [ ] Check account-level privacy and contact visibility requirements before rendering status data.
- [ ] Verify whether the required operations are reliable enough for a supported feature; document unsupported parts.
- [ ] Only after a supported API path is proven, request approval for a live status publication test.
- [ ] Build a separate Board status feed/workbench and API routes; keep these operations out of the inbox send path.

## Todo checklist

### 0. Inventory and guardrails

- [x] Inspect current repository state and use the clean managed WhatsApp worktree so unrelated primary-workspace edits remain untouched.
- [x] Confirm existing HTTP routes, polling semantics, media limits, and deployment entry points.
- [x] Check official whatsmeow docs for PostgreSQL support, events, QR pairing, media APIs, status limitations, and license.
- [x] Record current Baileys session retention and define explicit post-cutover cleanup; keep legacy auth until the new device pairs.
- [x] Confirm Go toolchain compatibility and pin an exact whatsmeow module revision in `go.mod`/`go.sum`.

### 1. Go service scaffold

- [x] Add `apps/whatsapp/go.mod`, `cmd/whatsapp/main.go`, and internal config, API client, health, account manager, queue, and message packages.
- [x] Read repository `.env` in local dev and validate API URL, token, database URL, port, and required secrets with safe production defaults.
- [x] Add HTTP `/health` and graceful shutdown; wait for API/database readiness without noisy retry logs.
- [x] Add unit tests for config validation, API auth headers, health state, and shutdown.

### 2. Persistent device ownership

- [x] Connect whatsmeow's SQL store to the existing PostgreSQL database with a dedicated schema/search path and documented pooler requirements.
- [x] Create the `whatsapp_service_devices` mapping table for company account IDs to whatsmeow device JIDs.
- [x] Add a PostgreSQL advisory lock/lease preventing a second service process from connecting the same company device.
- [x] Load existing devices by mapping on restart; create a new device only on explicit connect.
- [x] Keep encrypted Baileys `auth_state` unchanged during migration; never interpret it as a whatsmeow session.
- [x] Add PostgreSQL integration coverage for SQL schema creation, device persistence, and reload using an isolated schema.
- [x] Encrypt whatsmeow device/session key material in PostgreSQL using AES-256-GCM and a configured session key; migrate existing plaintext rows on startup and verify ciphertext in a fresh PostgreSQL integration database.
- [ ] Verify the production PostgreSQL provider and backups actually encrypt this session schema at rest; the app only checks an operator acknowledgment flag.
- [x] Guard SQLStore integration tests against a shared database. The pinned upstream migration helper checks `whatsmeow_version` globally by table name, so tests use a fresh dedicated PostgreSQL database and skip safely if one is not supplied.

### 3. QR and connection lifecycle

- [x] Poll the existing internal account/control endpoints and preserve connect/disconnect behavior.
- [x] Expose whatsmeow QR events through the existing `qr_code` account field without logging QR contents.
- [x] Map QR, connected, disconnected, logged-out, and reconnecting states into the API state machine.
- [x] Ensure requested disconnect does not immediately reconnect; resume persisted device only when requested or policy permits.
- [x] Test fake QR/pair/connected lifecycle; fixed a race where `connecting` could overwrite a fast QR update.
- [ ] Scan a fresh whatsmeow QR in Board and verify real pair, disconnect, reconnect, expiry, and service restart with the linked device.

### 4. Messaging parity

- [x] Claim PostgreSQL outbox jobs using existing lease, heartbeat, retry, and attempt-fencing endpoints.
- [x] Send private and group text; report the WhatsApp message ID and result to the API.
- [x] Download media for inbound events and upload media for outbound jobs within the existing 8 MB bound.
- [x] Support image, video, audio, document, and sticker payloads supported by the existing API model.
- [x] Process inbound private/group live messages, sender identity, names, timestamps, and own-message flags.
- [x] Process delivery/read receipts without downgrading message state.
- [x] Preserve idempotency through deterministic outbound IDs and API-side inbound event deduplication.
- [x] Add mock-driven Go tests for text/media, group/private JIDs, retries, receipts, and oversized media.
- [x] Decide history scope: do not backfill older chats in v1. whatsmeow can emit `events.HistorySync`, but safe import needs separate pagination, deduplication, media limits, retention, and company-scope handling; the Board inbox starts from messages received after pairing.

### 5. Workspace, Docker, and operations

- [x] Keep root `pnpm dev`, `pnpm start`, and `pnpm start:built` launching API, Board, and WhatsApp together.
- [x] Update workspace build/test scripts to build/test Go while retaining the package filter name expected by scripts.
- [x] Build the non-root WhatsApp runtime image; inspect it reports `node` as runtime user and exposes port 3100 with its health command.
- [x] Update development/production Compose, environment examples, and Docker build contexts.
- [x] Update docs for Go prerequisites, PostgreSQL schema, session backups, new QR pairing, rollback, and secret handling.
- [x] Pin whatsmeow and its transitive Go modules in `go.sum`; whatsmeow is MPL-2.0.
- [x] Validate Compose development and production configurations together with the base Compose file.

### 6. Verification and cutover

- [x] Run Go formatter check, `go vet`, Go unit tests (repeated), API WhatsApp route tests, and build API/Board/WhatsApp.
- [x] Run PostgreSQL SQLStore integration against a dedicated random test schema; verify device save/load after reopen.
- [x] Run Go race detector in Linux against the vendored module set.
- [x] Complete the targeted Board WhatsApp E2E run against isolated `moonwitness_e2e` PostgreSQL (2/2 passed).
- [x] Build `whatsapp-runtime` Docker target after vendoring Go modules so builder does not need Go proxy TLS access.
- [x] Run `pnpm dev`; API, Board, and WhatsApp health checks passed and the fresh whatsmeow QR is visible on the authenticated Board page.
- [ ] Scan a fresh whatsmeow QR. The already-paired whatsmeow session was verified to survive service restart without another QR, but a fresh QR scan has not been repeated in this turn.
- [x] Verify live text and image send only to the previously authorized test destination; inbound processing remains covered by mock tests because a second sender is unavailable.
- [x] Verify Board inbox, status progression, retry, and company-scope paths with mocked browser flows and authenticated API route tests.
- [ ] Keep Baileys session data until all checks pass; document/perform cleanup only after successful cutover.
- [x] Review the WhatsApp diff, commit the migration, and push to the repository's allowed `dev` ref.

### Verification record (2026-10-24)

- Go formatter check, repeated unit tests, `go vet`, and Linux `go test -race`: passed.
- WhatsApp API route tests: 13 passed.
- PostgreSQL SQLStore integration passed against a temporary dedicated database: SQL schema creation, encrypted private key at rest, legacy plaintext migration, device reload, and key round-trip were verified. The test skips safely against a shared database with existing whatsmeow tables.
- Board WhatsApp E2E: 2 passed against a separate `moonwitness_e2e` database.
- API, Board, and WhatsApp workspace builds: passed.
- Development and production Compose configuration checks: passed when layered on the base Compose file.
- `whatsapp-runtime` Docker image build: passed; the runtime image is non-root and contains the Go binary.
- Live WhatsApp pairing and provider/backups encryption verification remain open gates. Historical chat import is intentionally excluded from v1 by the decision above.

### Live cutover validation (2026-10-24)

- A text message was queued from Board, initially exposed a worker payload-format mismatch, and was delivered after the worker learned to accept both object and JSON-string outbox payloads.
- Fixed a startup migration loop: plaintext backfill now reads raw PostgreSQL bytes so encrypted ciphertext is skipped instead of being decrypted and re-encrypted on every startup.
- Sent a small PNG through Board to the previously authorized test number. The outbox reached `sent`, and the Board media endpoint returned the image for rendering after the conversation refreshed.
- Restarted the API, Board, and WhatsApp service through root `pnpm dev`; API `/readyz`, WhatsApp `/health`, the connected account, inbox, and sent text/image were verified afterward.
- Remaining cutover gates: scan a fresh pairing QR, verify provider and backup encryption from operator/provider evidence, and retain Baileys data until those gates pass.

### Follow-up validation (2026-10-24)

- Found and fixed the root `pnpm dev` launcher defect: the WhatsApp `run` action had been invoking `go ./cmd/whatsapp` instead of `go run ./cmd/whatsapp`.
- Local PostgreSQL's lib/pq connection default attempted SSL against a local server without TLS. Development now defaults SSL off only for known local PostgreSQL hosts when no `sslmode` was explicitly set; remote/production URLs and explicit SSL modes are unchanged.
- Root `pnpm dev` now builds the UI package before launching the apps, avoiding stale `packages/ui/dist` exports on a clean checkout.
- Go tests, `go vet`, WhatsApp API route tests (13), and the targeted Board login E2E (1) passed after the fixes.
- A real `pnpm dev` startup exposed healthy API `/readyz`, Board (HTTP 200 after the UI build), and WhatsApp `/health`. The test WhatsApp account was placed into QR state through the authenticated API; manual QR scan and post-pair verification still require the user.
- Signed in to the local Board as superadmin using the configured development password; the WhatsApp page displayed the new QR. The scan and post-pair checks remain a user handoff step.

## Completion criteria

- Go service runs through all established dev/start/Compose entry points and passes readiness checks.
- Board/API endpoints and PostgreSQL outbox/inbox contract remain stable and company-scoped.
- New QR pairing and persistence survive a service restart; a second instance cannot take ownership of the same device.
- Text, media, group, private, inbound, retry, and delivery/read behavior pass automated tests; live send is limited to the authorized test destination.
- Session at-rest protection and backup handling are explicitly verified and documented before production cutover.
- The cutover/rollback steps and test results are recorded in this plan or the final verification report.
