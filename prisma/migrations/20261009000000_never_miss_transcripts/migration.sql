-- Never-miss transcripts + CRM link mirror.
--  * Call: lineId / remoteNumber (E.164) / structured transcript / full-text search vector
--  * SyncCursor: lookback deep sweep + resumable history backfill
--  * Line: CRM SDR owner (from CRM User.alloPhoneNumber)
--  * CrmAction: read-only mirror of CRM CALL actions + their one-to-one vault Call link
--  * Drops Call.matchedCrmContactPhone / matchedCrmActionId: never written by anything,
--    superseded by CrmAction.callId.

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('PENDING', 'MATCHED', 'UNMATCHED', 'NO_PHONE');

-- CreateEnum
CREATE TYPE "MatchConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- DropIndex
DROP INDEX "Call_matchedCrmActionId_idx";

-- AlterTable
ALTER TABLE "Line" ADD COLUMN     "crmUserId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'env';

-- AlterTable
ALTER TABLE "SyncCursor" ADD COLUMN     "backfillDoneAt" TIMESTAMP(3),
ADD COLUMN     "backfillNextPage" INTEGER,
ADD COLUMN     "backfillUntil" TIMESTAMP(3),
ADD COLUMN     "lastDeepSweepAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Call" DROP COLUMN "matchedCrmActionId",
DROP COLUMN "matchedCrmContactPhone",
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "lineId" TEXT,
ADD COLUMN     "remoteNumber" TEXT,
ADD COLUMN     "transcriptAt" TIMESTAMP(3),
ADD COLUMN     "transcriptSegments" JSONB;

-- Full-text search: maintained by a trigger from summary + transcript, so it can never go stale and
-- the app never writes it. A trigger rather than a GENERATED column: Prisma reads a generated
-- column as having a default and would emit an invalid `DROP DEFAULT` on every later migrate diff;
-- triggers are invisible to it, so there is no drift.
ALTER TABLE "Call" ADD COLUMN "searchVector" tsvector;

CREATE FUNCTION "call_search_vector_update"() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('french'::regconfig, coalesce(NEW."aiSummary", '')), 'A') ||
    setweight(to_tsvector('french'::regconfig, coalesce(NEW."transcription", '')), 'B');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "call_search_vector_trg"
BEFORE INSERT OR UPDATE OF "aiSummary", "transcription" ON "Call"
FOR EACH ROW EXECUTE FUNCTION "call_search_vector_update"();

-- Existing rows.
UPDATE "Call" SET "aiSummary" = "aiSummary";

-- CreateTable
CREATE TABLE "CrmAction" (
    "id" TEXT NOT NULL,
    "sdrUserId" TEXT NOT NULL,
    "contactId" TEXT,
    "companyId" TEXT,
    "campaignId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "loggedAt" TIMESTAMP(3) NOT NULL,
    "phones" TEXT[],
    "callId" TEXT,
    "matchStatus" "MatchStatus" NOT NULL DEFAULT 'PENDING',
    "matchConfidence" "MatchConfidence",
    "matchReason" TEXT,
    "matchedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmAction_callId_key" ON "CrmAction"("callId");

-- CreateIndex
CREATE INDEX "CrmAction_loggedAt_idx" ON "CrmAction"("loggedAt");

-- CreateIndex
CREATE INDEX "CrmAction_matchStatus_loggedAt_idx" ON "CrmAction"("matchStatus", "loggedAt");

-- CreateIndex
CREATE INDEX "CrmAction_sdrUserId_loggedAt_idx" ON "CrmAction"("sdrUserId", "loggedAt");

-- CreateIndex
CREATE INDEX "CrmAction_contactId_idx" ON "CrmAction"("contactId");

-- CreateIndex
CREATE INDEX "CrmAction_companyId_idx" ON "CrmAction"("companyId");

-- CreateIndex
CREATE INDEX "CrmAction_clientId_loggedAt_idx" ON "CrmAction"("clientId", "loggedAt");

-- CreateIndex
CREATE INDEX "Line_crmUserId_idx" ON "Line"("crmUserId");

-- CreateIndex
CREATE INDEX "Call_remoteNumber_startedAt_idx" ON "Call"("remoteNumber", "startedAt");

-- CreateIndex
CREATE INDEX "Call_lineId_startedAt_idx" ON "Call"("lineId", "startedAt");

-- CreateIndex
CREATE INDEX "Call_searchVector_idx" ON "Call" USING GIN ("searchVector");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "Line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAction" ADD CONSTRAINT "CrmAction_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Best-effort backfill for rows synced before this migration. The next sync pass (and
-- scripts/backfill.ts) re-sights these calls and fills both columns properly through toE164();
-- this just makes already-E.164 rows usable immediately.
UPDATE "Call"
SET "remoteNumber" = CASE WHEN "direction" = 'INBOUND' THEN "fromNumber" ELSE "toNumber" END
WHERE (CASE WHEN "direction" = 'INBOUND' THEN "fromNumber" ELSE "toNumber" END) ~ '^\+[1-9][0-9]{7,14}$';

UPDATE "Call" c
SET "lineId" = l."id"
FROM "Line" l
WHERE l."providerId" = c."providerId"
  AND l."externalNumber" = CASE WHEN c."direction" = 'INBOUND' THEN c."toNumber" ELSE c."fromNumber" END;
