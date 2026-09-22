# Call Vault

A provider-agnostic call/audio storage service for `captainprospect-crm`. It owns every telephony
provider connection (WithAllo today; Leexi, Twilio, Aircall, Ringover as adapters land), stores
calls and recordings in its own Postgres + S3, and gives the CRM one stable, internal endpoint to
read from — so the CRM itself never talks to a provider, and can never surface a provider's
`429`/timeout as "request failed" again.

Full design/rollout plan: see the plan this was built from (schema rationale, why a separate DB,
why BullMQ, matching strategy per provider, phased rollout P0–P5).

## Why two processes

- **The Next.js app** (`npm run dev` / `npm run build && npm start`) serves the dashboard and
  `/api/calls` lookup endpoint. It can run anywhere, including serverless.
- **The worker** (`npm run worker`, i.e. `tsx worker.ts`) is the only process allowed to call
  WithAllo (and, later, other pollable providers). It must run as a **single long-lived process**
  — a Railway/Fly/Render "worker" service, a small VPS, a systemd unit, a Docker container that
  doesn't scale beyond 1 replica for this specific process. This is deliberate: the whole point is
  that exactly one thing enforces the provider's rate limit, globally, all the time. If this
  process is duplicated the way serverless functions duplicate, the 429 problem comes right back.

Both processes share the same `DATABASE_URL` and `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` — the
Next.js app reads what the worker writes; it never enqueues sync jobs itself in this phase.

## Setup

```bash
cp .env.example .env
# fill in DATABASE_URL (your own Postgres — not the CRM's), REDIS_*, ALLO_API_KEY, ALLO_NUMBERS

npm install
npx prisma migrate dev --name init
npm run seed:providers   # creates the 5 Provider rows + one Line per ALLO_NUMBERS entry

npm run worker           # in one terminal — starts syncing Allo
npm run dev              # in another — dashboard at http://localhost:5100
```

Check `http://localhost:5100/api/health` for a DB+Redis liveness probe.

## What P0 does today

- Syncs every active Allo `Line` on a cron (`ALLO_SYNC_CRON`, default every 2 minutes),
  **incrementally** — each run only walks pages newer than `SyncCursor.lastSyncedAt`, not a full
  rescan. This alone removes most of the 429 pressure the old per-action heuristic search caused.
- Mirrors each call's recording to storage (local disk in dev, S3 in production via
  `STORAGE_PROVIDER=s3`) exactly once; WithAllo's own media URL is never referenced again after
  that.
- Exposes `GET /api/calls?phone=&windowStart=&windowEnd=` (Bearer-auth'd with a vault `ApiKey`) —
  the phone+time-window heuristic match, but now a plain DB query instead of a live paginated
  provider scan. This is what the CRM should call instead of `AlloProvider.fetchMatchingCallRecord`.
- A circuit breaker (`lib/circuit-breaker.ts`) pauses a line for 5 minutes after 5 consecutive
  sync failures, instead of retry-storming it every cron tick.

## What's not built yet (see the plan for phasing)

- The CRM has **not** been cut over — `lib/call-enrichment/scheduler.ts` and the direct
  `AlloProvider` calls in captainprospect-crm are untouched. That's phase P1, deliberately kept
  separate from scaffolding this app so it can be tested in isolation first.
- Leexi, Twilio, Aircall, Ringover adapters are stubbed as inactive `Provider` rows only —
  no fetch logic yet.
- No outbound webhook delivery to the CRM (`WebhookDelivery` table exists, nothing writes to it
  yet) — P1.
- No per-key rate limiting is enforced on `/api/calls` yet (the `ApiKey.rateLimitPerMinute/Hour`
  columns exist for when the dashboard needs it); traffic here is expected to be low-volume
  CRM-internal lookups, not bulk.

## Minting a vault API key for the CRM

There's no admin UI for this yet — run once from a Node REPL / a one-off script:

```ts
import { generateApiKey } from "./lib/api-keys";
import { prisma } from "./lib/db";

const { fullKey, keyHash, keyPrefix } = generateApiKey();
await prisma.apiKey.create({
  data: { name: "captainprospect-crm", keyHash, keyPrefix, allowedEndpoints: ["/api/calls"] },
});
console.log(fullKey); // shown once — put it in the CRM's env as VAULT_API_KEY
```
