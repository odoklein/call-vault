# Call Vault

The system of record for every call `captainprospect-crm`'s SDRs make: audio, transcript, AI
summary, and which CRM contact / company / action / SDR each call belongs to. It owns every
telephony provider connection (WithAllo today; Leexi, Twilio, Aircall, Ringover as adapters land),
stores everything in its own Postgres + object storage (S3 or a self-hosted MinIO bucket), and
serves it to the CRM through a small authenticated API. The CRM never talks to a provider, and
the CRM's UI never shows the transcripts — the CRM's **MCP server** reads them from here
(`search_transcripts`, `get_transcript`, `get_call_coverage`).

```
 WithAllo ──(poll, 1 req/s, lookback + backfill)──▶  worker ──▶ Postgres (Call, transcript, FTS)
                                                        │   └──▶ S3 / MinIO (recordings)
 CRM Postgres ──(read-only: SDR numbers, CALL actions)──┘        │
                                                                 ▼
 CRM MCP (/api/mcp) ──(Bearer vault key, tenant passed)──▶ /api/calls/search, /api/calls/:id, /api/calls/coverage
```

## Guarantees ("never miss")

| Way a transcript used to go missing | What prevents it now |
| --- | --- |
| Allo attaches transcript/summary minutes **after** the call; the call was synced before that and never looked at again | Every run re-reads a **lookback window** (6 h) behind the cursor, plus a daily **deep sweep** (72 h). Content only accumulates — a later sighting never erases a transcript (`lib/sync/persist.ts`). |
| Page cap hit before reaching known calls → cursor jumped to the newest call, the gap was skipped forever | A capped walk hands the unread pages to the resumable **backfill** instead (`lib/sync/walk.ts`). |
| First sync only walked 20 pages — history mostly skipped | `npm run backfill -- --days=31` imports history page by page through the same rate-limited queue, resuming across restarts. |
| An SDR's Allo number wasn't in `ALLO_NUMBERS` → none of their calls synced | The CRM sync reads `User.alloPhoneNumber` and **auto-provisions** a line for every SDR number; coverage lists any SDR logging calls with no line. |
| Re-sighting a call downgraded a stored recording and re-downloaded it; one failed download was final | `STORED` is never downgraded; downloads run on their own queue with retries + a sweep that re-enqueues anything stuck `PENDING`. |
| A failing line looked freshly synced (error path wrote `lastSyncAt`); dashboard showed one cursor per provider, masking dead lines | Errors only write `lastError`; dashboard and coverage show **every line** with staleness. |
| CRM enrichment attached the **same** call to two actions, and a voicemail's summary to a booked meeting (both seen in production data) | The vault links calls to CRM actions **one-to-one**, on the SDR's own line, same E.164 number, call ended just before the action was logged (`lib/linking/matcher.ts`). Every link has a confidence + reason. |

`GET /api/calls/coverage` (and the dashboard) is the scoreboard: per SDR, CRM-logged calls vs vault
calls, links, conversations, transcripts present/missing, conversations never logged in the CRM,
failed recordings; per line, sync freshness and backfill progress.

## Multi-Client Portal (`calls.suzaliconseil.com`)

The portal supports multi-tenant role-based access:
- **Operator (Admin - Suzali Conseil)**:
  - Has full visibility across all numbers of the Allo account, sync health, and coverage.
  - Can view and manage all clients (e.g. Captain Prospect CRM).
  - Can select and configure which Allo phone numbers each client is allowed to see.
  - Can create and manage client users and client-scoped API keys.
  - Can preview the board exactly as any client sees it.
- **Client (e.g. Captain Prospect CRM)**:
  - Strict isolation enforced at the database query level (`lib/access.ts`).
  - Sees **only** calls, recordings, and transcripts from phone numbers explicitly granted to them by Suzali Conseil.
  - Numbers not granted to the client are completely invisible (404 on direct IDs, excluded from search, filtered from aggregate KPIs).
  - Secure audio streaming (`/media/calls/:id`) with HTTP Range support for seeking, without exposing object storage URLs.

## Processes

- **Next.js app** (`npm run build && npm start`, port 5100): multi-client dashboard at `calls.suzaliconseil.com` with session authentication (`cv_session`), scrypt password hashing, and authenticated REST API (`/api/calls*`).
- **Worker** (`npm run worker`): the only process that calls providers. Must run as a **single long-lived process** — exactly one thing enforces the provider's rate limit. Queues:
  - `vault-allo-sync` — per line, every 2 min: incremental + lookback, then one backfill step.
  - `vault-recording-mirror` — audio downloads, retried, plus a 10-min stale-`PENDING` sweep.
  - `vault-crm-sync` — every 5 min (if `CRM_DATABASE_URL`): SDR lines → line schedules → CALL actions → matcher.

## Setup / rollout

```bash
cp .env.example .env      # DATABASE_URL (own Postgres), REDIS_*, ALLO_API_KEY, storage
npm install
npx prisma migrate deploy # applies 20261009000000_never_miss_transcripts & 20261010000000_multi_client
npm run seed:providers    # Provider rows + one Line per ALLO_NUMBERS entry (optional once CRM sync is on)
npm run create-admin -- admin@suzaliconseil.com "Suzali Admin" # creates the first admin with a secure password
npm run worker            # one instance only
npm run build && npm start
```

**Configuring Client Access:**
1. Log in to `https://calls.suzaliconseil.com/login` as the Suzali Conseil admin.
2. Go to **Clients** (`/admin/clients`) and select or create the client (e.g., **Captain Prospect**).
3. Under **Numéros visibles par ce client**, check the Allo numbers that Captain Prospect is permitted to view, and click **Enregistrer les numéros**. Any unchecked number remains strictly private to Suzali Conseil.
4. Under **Utilisateurs**, create a user login for the client team, or mint a client-scoped API key under **Clés API**.

**CRM link (read-only).** Create a role on the CRM database and set `CRM_DATABASE_URL` on the worker:

```sql
CREATE ROLE call_vault_reader LOGIN PASSWORD '…';
GRANT SELECT ON "User", "Action", "Contact", "Company", "Campaign", "Mission" TO call_vault_reader;
```

The first CRM sync mirrors the last `CRM_ACTIONS_INITIAL_DAYS` (35) of CALL actions and
provisions a line for every SDR with an Allo number.

**Import last month.** Once the worker runs: `npm run backfill -- --days=31`. Watch progress in the
dashboard's Lines table or `GET /api/calls/coverage`. Calls and transcripts land first; audio
follows on the (deliberately slow) mirror queue.

**CRM MCP.** Nothing to configure beyond the existing `VAULT_API_URL` / `VAULT_API_KEY` — the
new endpoints live under `/api/calls`, which the CRM's key already allows.

## API (Bearer vault key, `allowedEndpoints` prefix `/api/calls`)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/calls?phone=&windowStart=&windowEnd=&limit=` | Legacy phone + window lookup used by CRM enrichment (unchanged). |
| `GET /api/calls/search?q=&crmClientId=&crmMissionId=&actionId=&contactId=&companyId=&sdrUserId=&phone=&from=&to=&hasTranscript=&limit=&cursor=` | French full-text over transcripts + summaries, structured filters, keyset pagination. Scoped to the key's client's granted lines. |
| `GET /api/calls/:id` / `GET /api/calls/:crmActionId?by=action` | One call in full: structured transcript (`SDR` / `PROSPECT` turns), summary, link. Same line grant rule. |
| `GET /api/calls/:id/recording` | Stable redirect to a fresh signed audio URL. |
| `GET /api/calls/coverage?from=&to=` | Completeness report (admin keys only). |
| `GET /api/health` | DB + Redis liveness. |

Mint a key: `npm run mint-api-key -- captainprospect-crm` or generate from the admin client page.

## Development

```bash
npm test          # 51 tests: client isolation, access rules, sync walker, merge rules, matcher, normalization, and every SQL statement on PGlite
npm run typecheck
npm run lint
```

## Not done yet (deliberately)

- **CRM enrichment still uses the old phone + calendar-day heuristic** (`GET /api/calls`, top-1 by
  content). The vault now holds a better, one-to-one link per action; switching
  `captainprospect-crm/lib/call-enrichment/vault-provider.ts` to `GET /api/calls/:actionId?by=action`
  would fix the mis-attached summaries in the CRM UI too. Left out because the brief was "keep them
  in the vault, not in the CRM".
- **Retention.** `Call.purgeAfter` exists but nothing purges. Recordings and transcripts of
  prospects are personal data — agree a retention period with whoever owns GDPR compliance and add
  a purge job; also propagate CRM exclusions / erasure requests here.
- **Provider push.** Allo webhooks would cut latency; polling + lookback is the safety net either way.
- **Other providers.** Leexi/Twilio/Aircall/Ringover rows exist; implementing an adapter is one
  `fetchPage` (`lib/providers/types.ts`) — cursor, lookback and backfill are shared.
