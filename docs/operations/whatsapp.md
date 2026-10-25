# WhatsApp gateway

The Board uses an externally hosted GoWA REST service. The API proxies all provider calls and
keeps GoWA credentials server-side; the browser never receives Basic Auth. The local Compose
stack no longer starts a WhatsApp gateway.

WhatsApp routes use the active company from the authenticated session; clients cannot choose a
GoWA device or another company's JID. `system` and `superadmin` can pair/disconnect and send. A
`user` can read within their active company and needs explicit `ModelAccess` grants for
`whatsapp.account.write`, `whatsapp.conversation.create`, or `whatsapp.message.create` to perform
those actions. The account endpoint returns capabilities so Board only shows permitted controls.

## Local development

Start PostgreSQL with `docker compose up -d`, then run `pnpm dev`. This starts API, Board, and the
PostgreSQL outbox worker together. The development stack already
points `WHATSAPP_GATEWAY_URL` at the hosted gateway; override it in `.env` together with
`WHATSAPP_GATEWAY_USERNAME` and `WHATSAPP_GATEWAY_PASSWORD` when the address or credentials
differ. The API and Compose development fallback is `https://wa.moonwitness.biz.id`. The
expected GoWA version defaults to `v9.6.0`; set `WHATSAPP_GATEWAY_EXPECTED_VERSION` explicitly
when deliberately upgrading. `/whatsapp/readyz` reports reachable only when both `/health` and
`/app/info` succeed and the reported version matches that expectation.

Open `http://localhost:5173/board/whatsapp` and choose **Connect WhatsApp**. The API creates a
stable GoWA device slot for the active company, requests its QR, and proxies the QR image to the
Board. Scan it from WhatsApp → Linked devices. Board polls account status, conversations, and
messages from the API as a refresh and recovery path. When inbound webhooks are configured, GoWA
also pushes `message` and `message.ack` events to the API; these update the company-scoped message
cache and outbound delivery/read status. Messages are sent through GoWA's REST endpoints, including
group chats and media.

To enable webhooks, set `WHATSAPP_WEBHOOK_URL` to the public HTTPS origin of this API and set
`WHATSAPP_WEBHOOK_SECRET` to a random secret of at least 32 characters. Development and production
Compose pass both values to the API only; configure them in `.env` or the deployment secret store.
The API sets a device-specific callback when the company connects. GoWA
must be able to reach this origin over HTTPS. The callback verifies GoWA's `X-Hub-Signature-256`
HMAC against the raw request body and checks the GoWA `session_id` against the mapped device.
Leave both values unset to use REST polling only. Do not use a localhost URL for a hosted GoWA
instance. The account endpoint exposes only a boolean `webhook_configured`; the Board warns when
callbacks are disabled and the inbox relies on periodic refresh. It never returns the webhook
secret.

GoWA owns WhatsApp credentials and provider chat history in its own storage on the hosted
deployment. The Moonwitness database stores the company-to-device mapping and a company-scoped
inbox cache. Message media, contact avatars, and Status media use the shared attachment storage
configured by `ATTACHMENT_STORAGE_DRIVER`; their object keys are referenced from PostgreSQL, while
the bytes are not stored in the database.

With `ATTACHMENT_STORAGE_DRIVER=local`, bytes live under `ATTACHMENT_STORAGE_DIR`. Compose
development defaults to this driver and mounts the persistent `whatsapp_dev_attachments` volume at
`/var/lib/moonwitness/attachments`, shared by the API and outbox worker. With
`ATTACHMENT_STORAGE_DRIVER=s3`, bytes live in the configured private S3-compatible bucket;
production Compose defaults to Garage at `s3.moonwitness.biz.id`. The production
`whatsapp_attachments` volume is a read-only legacy local store for rollback or unmigrated objects;
new S3 objects are not written there, and the API does not automatically fall back between stores.
Do not remove either the active bucket or any local volume that still contains referenced objects.
RustFS has passed generic S3 adapter tests, but it is not the configured production endpoint. See
the [attachment storage operations guide](./attachment-storage.md) for cutover, retention, backup,
and restore procedures.

`GET /whatsapp/readyz` probes the GoWA `/health` endpoint with a five-second timeout and returns
200 when reachable or 503 when unavailable. This check is separate from `/readyz`, so a GoWA
outage does not take the API itself out of service. The authenticated `/whatsapp/account` endpoint
reports a logged-out device as `disconnected` and a failed gateway request as `error`.

Pairing, failed pairing, disconnect, queued sends, retries, and successful media access append
privacy-safe records to `audit_logs`. WhatsApp audit metadata contains the company scope and action
IDs only; message content, phone numbers, QR data, and provider credentials are excluded.

Outbound delivery retries use the shared outbox exponential backoff (capped at one hour), stop
after five total delivery attempts, and expire after 24 hours from queue creation. Messages that
expire before processing are marked failed without a GoWA send.

Message history is paged in 50-message Board batches, with provider `limit`/`offset` and an API
offset cap of 5,000. Polling the newest page uses GoWA's `start_time` filter with a 10-minute
overlap from the newest cached message timestamp; older pages are fetched by offset. GoWA's
published Chat API contract documents both offset and ISO-8601 `start_time` filters.

Provider message timestamps are normalized to UTC. Messages with an invalid/missing provider
timestamp are skipped rather than assigned the current time, and cached latest-message previews
are not moved backward by late-arriving older messages. Invalid chat-list timestamps preserve the
last valid cached time.

The Board can explicitly send a GoWA read receipt for the newest inbound message currently cached
in a conversation using `POST /message/{message_id}/read`. After GoWA acknowledges it, the API
stores a read cursor for that company, conversation, and Board user. Inbox unread counts are derived
from cached inbound messages after that cursor. When a chat's provider timestamp advances, the API
syncs up to 100 recent messages so unopened conversations can appear in the Unread filter. This is
best-effort: if more than 100 messages arrive between syncs, or older history was never cached, the
count can be low. GoWA's `/chats` response does not expose an authoritative unread total.

Media MIME types are derived from file signatures rather than trusted from browser/provider headers.
Uploads with a specific declared MIME must match supported signatures. Unknown downloaded bytes are
served as `application/octet-stream` with attachment disposition and `X-Content-Type-Options: nosniff`;
known image/audio/video/PDF signatures can be shown inline. Generic octet-stream uploads remain
download-only and are not malware-scanned. Every media response also sets a restrictive CSP
(`default-src 'none'; sandbox; base-uri 'none'; form-action 'none'`), including responses shown inline.
The API rejects a provider download whose body length disagrees with an uncompressed
`Content-Length`, before caching any partial bytes.

When the configured attachment driver supports streaming, provider media downloads flow directly
into storage and then to the authorized Board response. Local storage writes through a temporary
file and atomically renames it; S3 storage uses multipart upload with one part in flight. Both paths
enforce the 10 MiB attachment limit, and API route tests verify streaming storage methods are used
for provider downloads and cached reads. Compatibility storage adapters without stream methods
continue to use the bounded Buffer path.

With an S3-compatible attachment driver, the WhatsApp Board receives a user/company/conversation-
scoped upload ticket and a five-minute presigned POST policy. The policy locks one UUID object key,
the normalized content type, and a 1-byte to declared-size range (at most 10 MiB). After direct
upload, the API checks the stored size/type, reads the object through a bounded stream, validates
the file signature, and scans it before queueing a message. It copies the verified bytes to a new
server-generated key before queueing so replaying an unexpired upload policy cannot change media
already queued for delivery. Expired staging objects are eligible for the attachment reconciliation
command after its configured grace period. Configure the S3 endpoint CORS policy to allow the Board
origin and `POST`; the browser sends no API credentials to the storage host. Local attachment
storage continues to use authenticated multipart uploads through the API.

After GoWA confirms an outbound send, the worker first records the provider message ID in the
outbox payload, then marks the message sent and updates the conversation preview. A retry can use
that durable acknowledgement to repair either database projection without sending again. If
PostgreSQL is unavailable before the acknowledgement can be saved, the delivery remains ambiguous
and must be verified manually; the worker never retries that send blindly.

For a lost/ambiguous HTTP response, message history can reconcile a matching outbound message only
when exactly one local `unknown`/`sending` candidate has the same company, conversation, body, media
type, and timestamp within two minutes. Multiple matches stay unresolved for manual verification.
This uses GoWA's documented `is_from_me` and message timestamp fields in its
[ChatMessage schema](https://github.com/aldinokemal/go-whatsapp-web-multidevice/blob/main/docs/openapi.yaml#L5803-L5845);
the matching rule is covered by route tests, but has not yet been verified against an actual hosted
device history response.

Provider message IDs are unique per company, matching the current one-device-per-company
constraint. Message history upserts are therefore idempotent within that scope and cannot collide
between companies. Route tests cover response loss before/after acceptance, permanent 4xx,
transient 5xx, replayed outbox events, and late previews; PostgreSQL-specific integration remains
unverified when its test fixture is unavailable.

Archive/unarchive and pin/unpin actions are company-scoped, require
`whatsapp.conversation.write`, and are audited. Archive state syncs from GoWA's chat list and can be
filtered with its `archived` parameter. Pin state is stored when Board changes it and affects local
inbox order; GoWA v9.6.0's chat-list schema does not expose pin state, so changes made from the phone
are not reflected yet. The v9.6.0 contract documents archive/pin actions but no mute endpoint.

The conversation list also loads in 50-item Board pages. API requests validate `limit` and `offset`,
scope cached rows to the authenticated company, and sort by provider message time with record ID as
a stable tie-breaker.

GoWA's chat-list schema exposes the latest message timestamp but not its content. For inbox pages,
the API fetches up to five recent messages for chats with a missing/stale preview, selects the newest
timestamp, and caches its text or a media placeholder. Preview refresh runs at most four requests in
parallel and reuses the cache while the provider timestamp is unchanged.

Conversation search accepts a search query parameter and matches cached conversation names,
JIDs/phone numbers, and message text within the active company inbox. Board waits 250 ms after
typing before querying. API merges GoWA documented `/chats?search=` name results with the normal chat page, then matches cached message content locally. Message text is searchable after its conversation has been synchronized. The hosted v9.6.0 version and health endpoints are live-tested; the search parameter is documented in the [GoWA OpenAPI contract](https://github.com/aldinokemal/go-whatsapp-web-multidevice/blob/main/docs/openapi.yaml) but not yet exercised on the hosted device.

GoWA introduced multi-device support in v8. On 24 October 2026, authenticated requests to the
hosted gateway returned version `v9.6.0` from `/app/info` and `OK` from `/health`; on 25 October,
the credentials configured in the primary checkout returned HTTP 200 from `/app/info`. The live
contract test passed. This verifies gateway authentication and contract only, not a linked device
or actual message delivery. One stable slot is created per Moonwitness company. See the [GoWA OpenAPI contract](https://github.com/aldinokemal/go-whatsapp-web-multidevice/blob/main/docs/openapi.yaml)
and [GoWA release notes](https://github.com/aldinokemal/go-whatsapp-web-multidevice).

## Production

The production API connects to an independently managed GoWA service. Set
`WHATSAPP_GATEWAY_URL`, `WHATSAPP_GATEWAY_USERNAME`, and `WHATSAPP_GATEWAY_PASSWORD` in the
production environment. Use a private network and HTTPS where traffic crosses hosts. The
production Compose file does not start another WhatsApp runtime; GoWA remains the owner of
paired sessions and its own persistent storage. The API expects GoWA `v9.6.0` by default and
will report the gateway not ready if `/app/info` returns another version; review compatibility
and set `WHATSAPP_GATEWAY_EXPECTED_VERSION` as part of an intentional GoWA upgrade.

The API makes GoWA calls for account control, QR, and inbox reads; the outbox worker sends queued
messages and Status updates. Device-specific webhooks are optional; the Board inbox keeps polling
GoWA's chat REST API as a recovery path. Production Compose passes GoWA Basic Auth only to `api`
and `outbox-worker`; the webhook HMAC secret is passed only to `api`. `board`, `jobs-worker`, and
`jobs-scheduler` receive neither secret. Both production Compose variants have a contract test for
these boundaries. Compose does not filter outbound network destinations, so enforce any egress
allowlist for the hosted GoWA endpoint at the container host or network firewall.

### Publishing the API origin

WhatsApp lives at the API root, not under `/api`. Anything in front of the API must forward every
prefix the Board proxies: `/api`, `/auth`, `/jsonrpc`, `/health`, `/livez`, `/readyz`, `/metrics`,
`/notifications`, `/workflows`, and `/whatsapp`. A proxy with a narrower allowlist answers `404` for
`/whatsapp/*` while `/health` still succeeds, which looks like a missing WhatsApp build but is a
routing gap. Allow `POST` to `/whatsapp/gowa/webhook/<device id>` and let request bodies of at least
15 MiB through so Base64 WhatsApp sends are not truncated; files stay capped at 10 MiB by the
application. Verify the published origin before changing WhatsApp configuration:

```powershell
pnpm whatsapp:verify:deployment -- --base-url https://your-api-origin
```

The probe sends no credentials. It classifies the origin first, so a different application or a
placeholder worker answering on the domain is reported as `wrong-origin` instead of being mistaken
for missing WhatsApp routes. Only a `ready` result means the route set, the registered WhatsApp
models, and the signed callback endpoint are actually reachable.

### Enabling the GoWA callback

Set `WHATSAPP_WEBHOOK_URL` to the verified public origin (scheme and host only, no path) and
`WHATSAPP_WEBHOOK_SECRET` to a random value of at least 32 characters; both must be present or the
API refuses to start pairing. Restart the API, then trigger Connect for the account. The API pushes
`<origin>/whatsapp/gowa/webhook/<device id>`, the secret, and the event list to GoWA during that call,
so an already linked device is reconfigured without scanning a QR code again. Confirm with a read-only
GoWA `GET /devices/<device id>/webhook` that `webhook_url` and `webhook_events` are no longer empty, then
send a message from another number and check it appears in the Board inbox. Inbound events are also
recovered by polling, so a callback failure degrades to delayed delivery rather than lost messages.

## Full WhatsApp restore order

Treat a WhatsApp recovery as one coordinated set: PostgreSQL (account/device mapping, inbox,
outbox, and audit metadata), the configured attachment store (message media, thumbnails, and
cached profile images), and GoWA's own persistent device/session data. The GoWA deployment is
external to this Compose project, so identify its actual volume or bind mount and backup method
from that deployment before an incident; do not assume a volume name from this repository.

1. Declare a maintenance window. Stop the API and all database writers (`outbox-worker`,
   `jobs-worker`, and `jobs-scheduler`), pause webhook delivery at GoWA, and stop the GoWA
   container only when its own documented backup method requires a stopped filesystem. Do not
   allow queued sends to run against a partially restored data set.
2. Select backups that belong to the same recovery point. Record timestamps, API commit, exact
   GoWA image digest/version, expected GoWA version, attachment driver/bucket, and identifiers of
   the database/object/session backups. If the backups are from incompatible points or any one
   component is missing, stop; do not combine unrelated snapshots and claim session recovery.
3. Restore GoWA's persistent data with the GoWA deployment's documented procedure and the matching
   image digest. Keep the restored service isolated from production until its storage is verified.
4. Restore the PostgreSQL dump to a new/isolated database, and restore the matching attachment
   bucket or local volume to an isolated target. Never overwrite the live database or bucket during
   a drill. Follow the detailed object-store checks in
   [attachment storage operations](./attachment-storage.md#operasi-dan-pemulihan).
5. Before enabling writers, verify database readiness and account/company/device mappings; check
   that the expected GoWA version matches the restored image; run `attachments:reconcile` in
   dry-run mode and investigate missing/corrupt references. Do not delete orphan candidates as
   part of restore validation.
6. Start GoWA and confirm authenticated `/health`, `/app/info`, and the expected device/session
   state. Then start the API against the restored database and attachment target, verify
   `/whatsapp/readyz`, and confirm Board shows the expected account only in its company scope.
7. Inspect queued, `sending`, and `unknown` outbound messages before resuming `outbox-worker`.
   Resolve ambiguous sends against GoWA history or manually; never blindly replay them. Resume
   webhook delivery, workers, and scheduling only after the database, GoWA session, and media
   checks pass. Verify receipt, inbox sync, and an approved test send/receive end to end.

If GoWA's session backup is absent or cannot be restored, follow the QR pairing recovery path in
this runbook and treat it as a new linked-device session; do not claim that the old session was
recovered. This procedure defines the order and safety checks only. A full coordinated restore
drill remains unproven and is tracked separately under P0-25, P2-15, and P4-37 in `todo-wa.md`.

## GoWA compatibility and rollback

The version check is exact-string matching, not a claim that neighboring releases are compatible.
The current matrix is:

| GoWA version      | API readiness       | Evidence and limit                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v9.6.0`          | Accepted by default | Authenticated live `/health` and `/app/info` contract passed 2/2 on 25 October 2026; a fresh `/app/info` check returned HTTP 200 and exact `v9.6.0`. The hosted `/devices` response is still `results: null`, so QR pairing, session persistence, media delivery, and messages have not been verified on a real device. |
| Any other version | Rejected by default | No other GoWA version has a compatibility result in this repository. Setting `WHATSAPP_GATEWAY_EXPECTED_VERSION` changes the exact readiness comparison only; it is not evidence that the API features work with that release.                                                                                          |

Before an upgrade, record the current GoWA image digest/tag from the deployment host, API release/commit,
and configured expected version. Take a backup of GoWA's own persistent data and prove that the
backup can be read and restored before changing versions; this prerequisite is tracked in
`todo-wa.md` P0-25. Keep the previous image digest and the matching pre-upgrade backup together.

Test the candidate GoWA image and API version in staging first. During the production maintenance
window, pause the outbox worker so queued messages are not sent while the gateway/API versions are
in transition. Update the GoWA image and `WHATSAPP_GATEWAY_EXPECTED_VERSION` as one deployment
change, then verify authenticated `/health` and `/app/info`, API `/whatsapp/readyz`, Board account
status, and device session state. Resume the outbox only after those checks pass. Verify actual
send/receive behavior with an approved test device and recipient before the maintenance is closed.

For rollback, pause the outbox worker, restore the previous GoWA image and its matching data backup
if the upgraded version changed its storage format, restore the previous expected-version setting,
and restart API/outbox worker. Recheck gateway and account status before resuming queued sends. Do
not downgrade a GoWA binary against data already migrated by a newer release without restoring the
pre-upgrade backup. Retain the backup until the upgraded device session and message flows have been
verified. This is a runbook procedure; an actual host image digest, backup restore, and linked-device
upgrade/rollback have not yet been tested.

## GoWA credential rotation

Store the GoWA Basic Auth username and password in the deployment secret manager when one is
available. The Compose `.env.prd` file is only a deployment input, not a secret manager: keep it
outside version control and readable only by the deployment operator. Never put credentials in a
`curl -u` argument, shell command, ticket, or log.

When rotating credentials, provision the replacement at GoWA first if the provider supports
overlapping credentials. Update `WHATSAPP_GATEWAY_USERNAME` and `WHATSAPP_GATEWAY_PASSWORD` in the
deployment secret store, then recreate `api` and `outbox-worker` together so both use the same
pair. If GoWA allows only one active pair, schedule the provider change and service restart as one
maintenance action; queued messages remain in PostgreSQL while the worker restarts. Check
`GET /whatsapp/readyz` from the deployed API and verify account status in Board before revoking the
old credential. If validation fails, restore the previous pair and recreate both services before
revoking it. This procedure does not rotate `WHATSAPP_WEBHOOK_SECRET`; webhook key rotation needs a
coordinated GoWA callback update and is not yet automated.

## Troubleshooting

- **QR is missing or will not scan:** open the WhatsApp account panel and check its status. For
  `qr_expired`, choose **Refresh QR code** and scan the new code from WhatsApp → Linked devices.
  For `disconnected`, choose **Connect WhatsApp**. If the controls are absent, confirm the active
  company and that the user has `whatsapp.account.write`; never copy a QR into a ticket or log.
- **Gateway reports unavailable or pairing gets an auth error:** request the unauthenticated
  `GET /whatsapp/readyz` endpoint from the API host. A 503 means the gateway check failed; the
  endpoint intentionally does not reveal credentials or the precise upstream error. From the
  repository checkout, run the live contract test with the deployment environment loaded:
  `$env:GOWA_CONTRACT_TEST='1'; pnpm --filter @moonwitness/api exec vitest run tests/gowa.contract.test.ts`.
  It checks authenticated `/health` and the expected `/app/info` version. If it fails, confirm
  `WHATSAPP_GATEWAY_URL`, `WHATSAPP_GATEWAY_USERNAME`, `WHATSAPP_GATEWAY_PASSWORD`, and
  `WHATSAPP_GATEWAY_EXPECTED_VERSION` are present and identical in both API and outbox-worker
  deployment environments. Production must not use the development fallback credentials. Do not
  paste credentials or an Authorization header into logs or support tickets.
- **Device is missing:** check `/whatsapp/account` while signed in to the affected company. If it
  reports `disconnected` or a missing device mapping, use **Connect WhatsApp** to request a QR for
  that company's stable GoWA slot. Confirm the device exists and is logged in in GoWA's own admin
  interface; do not delete a GoWA device to repair a company mapping unless intentionally unlinking
  that WhatsApp account. Pairing against the hosted gateway requires a real QR scan.
- **Attachment storage is unavailable or full:** `/readyz` checks PostgreSQL and the configured
  attachment storage; a storage failure returns 503. For local storage, check free space, write
  permission, and that the API and outbox worker mount the same `ATTACHMENT_STORAGE_DIR`. For S3,
  check bucket reachability, credentials, quota, and provider logs. Production's legacy local volume
  is read-only and is not an S3 fallback. Restore storage capacity before retrying queued media.
- **WhatsApp was logged out:** the account panel reports `disconnected`; reconnect and scan a fresh
  QR. A gateway outage appears as `error` and should be resolved before pairing again. Disconnect
  from Board deliberately unlinks the GoWA device; do not use it as a connectivity retry.

## Monitoring

Configure a `METRICS_TOKEN` of at least 32 characters and scrape API `GET /metrics` with that value
as a Bearer token. The endpoint includes GoWA request duration and outcome by allowlisted route,
current in-flight requests, aggregate account state, WhatsApp message/Status outbox counts, retried
and dead events, oldest active queue age, inbox polling endpoint duration, and inbound/outbound
media byte counters. Outbox/account values are database aggregates; request, poll, and media
counters are process-local and reset when a process restarts. For send-side GoWA timings, scrape the
outbox worker's `/metrics` too: configure `OUTBOX_WORKER_HEALTH_PORT` above zero and, if a separate
scraper container needs access, set `WORKER_HEALTH_HOST=0.0.0.0` while keeping the worker on a private
container network and publishing no public port. The same Bearer token is required. When scraping
both API and worker, use the API's database gauges once and aggregate process-local counters across
instances. Poll duration covers account/inbox API reads (including user refreshes), not only
background polling. Labels contain only bounded route/state/direction values; they never include
company IDs, phone numbers, JIDs, message content, object keys, or credentials. Database metric
availability is exposed separately so a failed scrape query is not mistaken for an empty queue.

Alert expressions are provided in [`deploy/monitoring/whatsapp-alerts.yml`](../../deploy/monitoring/whatsapp-alerts.yml).
Import that rule group into Prometheus and route `severity` labels through the deployment's
Alertmanager. The expressions expect Blackbox Exporter jobs named `moonwitness-whatsapp-readyz`
probing `/whatsapp/readyz` and `moonwitness-api-readyz` probing `/readyz`; configure targets to your
actual API origin. The WhatsApp readiness probe validates GoWA reachability and expected version.
The API readiness probe checks PostgreSQL and attachment storage. Local storage readiness writes,
syncs, and removes a one-byte probe file; S3 readiness checks the configured bucket. A disconnected
account alert also fires for intentionally disconnected accounts, so silence it during planned
unpairing. The rules are checked with the pinned Prometheus 2.55.1 `promtool`; the test fixture
asserts all seven alerts fire on matching metrics and that stale outbox age without active events
does not page:

```powershell
docker run --rm --mount "type=bind,source=$($PWD.Path),target=/src,readonly" --entrypoint=/bin/promtool prom/prometheus:v2.55.1 check rules /src/deploy/monitoring/whatsapp-alerts.yml
docker run --rm --mount "type=bind,source=$($PWD.Path),target=/src,readonly" --entrypoint=/bin/promtool prom/prometheus:v2.55.1 test rules /src/deploy/monitoring/whatsapp-alerts.test.yml
```

Rule definitions are not active until loaded and notification routing is tested in the deployment.

## Verification

- `pnpm test:whatsapp` runs API route tests with a mocked GoWA service and file-signature tests.
- `pnpm whatsapp:verify:deployment -- --base-url <origin>` probes a published origin without credentials
  and fails until the API root, the WhatsApp models, and the signed callback route are all reachable.
- `pnpm --filter @moonwitness/api build` and `pnpm --filter @moonwitness/board typecheck`
  check the API connector and Board UI.
- Check the deployed API's configured GoWA authentication, health, and expected version without
  putting credentials on the command line:
  - PowerShell: `Invoke-WebRequest "$env:API_ORIGIN/whatsapp/readyz" -UseBasicParsing`
  - POSIX shell: `curl --fail --silent --show-error "$API_ORIGIN/whatsapp/readyz"`
- For a direct contract test in a checkout whose `.env` is already loaded, the test output never
  prints credential values:
  - PowerShell: `$env:GOWA_CONTRACT_TEST='1'; pnpm --filter @moonwitness/api exec vitest run tests/gowa.contract.test.ts`
  - POSIX shell: `GOWA_CONTRACT_TEST=1 pnpm --filter @moonwitness/api exec vitest run tests/gowa.contract.test.ts`

The current `/chats` response does not expose an authoritative unread count. With the webhook
enabled, new message events enter the cache immediately and unread state is derived from cached
inbound messages and per-user read cursors. Polling still syncs up to 100 recent messages as a
recovery path, so historical messages that predate webhook activation may remain missing. GoWA
maintainers likewise describe deriving unread state from message events or last-seen tracking
([discussion](https://github.com/aldinokemal/go-whatsapp-web-multidevice/discussions/520)).

The provider is a linked-device WhatsApp integration, not the official Meta WhatsApp Business
Platform. Keep normal WhatsApp messaging policies and rate limits in mind.
