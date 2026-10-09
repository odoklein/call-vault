// Every SQL statement the vault runs against the CRM, in one place — this file IS the coupling to
// the CRM schema. Executed for real against a fixture of those tables in test/crm-queries.test.ts.
//
// Dates cross the boundary as ISO strings (cast explicitly), never as driver-typed Date params:
// the CRM's columns are Prisma `timestamp(3)` holding UTC, and an implicit timestamptz cast would
// shift them by the session time zone.

import { Prisma } from "@prisma/client";

export interface CrmSdrNumberRow {
  id: string;
  alloPhoneNumber: string;
  isActive: boolean;
}

export function sdrNumbersQuery(): Prisma.Sql {
  return Prisma.sql`
    SELECT u.id, u."alloPhoneNumber", u."isActive"
    FROM "User" u
    WHERE u."alloPhoneNumber" IS NOT NULL AND btrim(u."alloPhoneNumber") <> ''`;
}

export interface CrmCallActionRow {
  id: string;
  sdrId: string;
  contactId: string | null;
  companyId: string | null;
  campaignId: string;
  missionId: string;
  clientId: string;
  result: string;
  /** ISO-8601 UTC */
  loggedAt: string;
  meetingPhone: string | null;
  contactPhone: string | null;
  contactAdditionalPhones: unknown;
  companyPhone: string | null;
  companyCustomData: unknown;
}

/** CALL actions logged after (sinceIso, afterId), keyset-paginated in log order. */
export function callActionsQuery(sinceIso: string, afterId: string, limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT a.id,
           a."sdrId",
           a."contactId",
           COALESCE(a."companyId", c."companyId") AS "companyId",
           a."campaignId",
           camp."missionId",
           m."clientId",
           a.result::text AS result,
           to_char(a."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "loggedAt",
           a."meetingPhone",
           c.phone AS "contactPhone",
           c."additionalPhones" AS "contactAdditionalPhones",
           co.phone AS "companyPhone",
           co."customData" AS "companyCustomData"
    FROM "Action" a
    JOIN "Campaign" camp ON camp.id = a."campaignId"
    JOIN "Mission" m ON m.id = camp."missionId"
    LEFT JOIN "Contact" c ON c.id = a."contactId"
    LEFT JOIN "Company" co ON co.id = COALESCE(a."companyId", c."companyId")
    WHERE a.channel::text = 'CALL'
      AND (a."createdAt", a.id) > ((${sinceIso}::timestamptz AT TIME ZONE 'UTC'), ${afterId})
    ORDER BY a."createdAt", a.id
    LIMIT ${limit}`;
}
