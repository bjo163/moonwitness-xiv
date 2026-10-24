# WhatsApp gateway verification

## Current provider

The development Compose service uses GoWA v9.6.0. On 24 October 2026, the local container
responded to `/health` with HTTP 200 and `/app/info` reported `v9.6.0`. The provider's `/devices`
endpoint returned an empty device list at the time of the connector change, so a QR pairing and
real message delivery were not performed as part of that change.

## Integration checks

`pnpm test:whatsapp` exercises authenticated Board API routes with a mocked GoWA server. The
tests cover company scoping, stable per-company device IDs, QR/status mapping, chat/message
mapping, message sends and provider errors. They do not open a WhatsApp session or deliver
messages to a real contact.

The GoWA REST chat list returns basic chat metadata but no unread counters or message previews.
Board refreshes the latest 100 conversations every five seconds and loads the latest 100 messages
when a conversation is opened. It derives that conversation's preview from the fetched history;
unread badges are not authoritative in this integration.

Run `pnpm --filter @moonwitness/api build` and
`pnpm --filter @moonwitness/board typecheck` for static checks. A real pairing requires the
company administrator to scan the QR displayed in Board. Real sends must use an explicitly
approved test recipient.

## Data boundary

Board requests authenticate to Moonwitness API and are scoped to the active company. The API
selects that company's GoWA device slot from its PostgreSQL account mapping and supplies the
provider Basic Auth credentials server-side. GoWA stores linked-device credentials, chats, and
messages in its own persistent storage volume. PostgreSQL stores company-scoped inbox cache and
the provider device mapping; downloaded media may be cached in the API attachment volume.
