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
`WHATSAPP_WEBHOOK_SECRET` to a random secret of at least 32 characters. Compose development and
production pass both values to the API and worker containers; configure them in `.env` or the
deployment environment. The API sets a device-specific callback when the company connects. GoWA
must be able to reach this origin over HTTPS. The callback verifies GoWA's `X-Hub-Signature-256`
HMAC against the raw request body and checks the GoWA `session_id` against the mapped device.
Leave both values unset to use REST polling only. Do not use a localhost URL for a hosted GoWA
instance. The account endpoint exposes only a boolean `webhook_configured`; the Board warns when
callbacks are disabled and the inbox relies on periodic refresh. It never returns the webhook
secret.

GoWA owns WhatsApp credentials and chat history in its own storage on the hosted deployment. The
Moonwitness database stores the company-to-device mapping and a company-scoped inbox cache. API
media downloads are cached in `whatsapp_attachments`. Do not delete that volume while cached
attachments are still needed.

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

The API makes outbound REST calls to GoWA. Device-specific webhooks are optional; the Board inbox
keeps polling GoWA's chat REST API as a recovery path. No shared internal token is used between
services.

## Verification

- `pnpm test:whatsapp` runs API route tests with a mocked GoWA service and file-signature tests.
- `pnpm --filter @moonwitness/api build` and `pnpm --filter @moonwitness/board typecheck`
  check the API connector and Board UI.
- `curl -u "$WHATSAPP_GATEWAY_USERNAME:$WHATSAPP_GATEWAY_PASSWORD" "$WHATSAPP_GATEWAY_URL/app/info"`
  checks the hosted provider. The app-info response reports its deployed GoWA version.

The current `/chats` response does not expose an authoritative unread count. With the webhook
enabled, new message events enter the cache immediately and unread state is derived from cached
inbound messages and per-user read cursors. Polling still syncs up to 100 recent messages as a
recovery path, so historical messages that predate webhook activation may remain missing. GoWA
maintainers likewise describe deriving unread state from message events or last-seen tracking
([discussion](https://github.com/aldinokemal/go-whatsapp-web-multidevice/discussions/520)).

The provider is a linked-device WhatsApp integration, not the official Meta WhatsApp Business
Platform. Keep normal WhatsApp messaging policies and rate limits in mind.
