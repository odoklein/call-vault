// Read-only connection to the CRM's Postgres, used by the directory sync only. Point
// CRM_DATABASE_URL at a role with SELECT on "User", "Action", "Contact", "Company", "Campaign",
// "Mission" and nothing else — the vault never writes to the CRM.
//
// A second PrismaClient over the vault's generated client is fine here: only $queryRaw is used,
// which doesn't touch the vault's models. No new driver, no second schema to generate.

import { PrismaClient } from "@prisma/client";

let client: PrismaClient | null | undefined;

export function getCrmDb(): PrismaClient | null {
  if (client !== undefined) return client;
  const url = process.env.CRM_DATABASE_URL;
  client = url ? new PrismaClient({ datasourceUrl: url }) : null;
  return client;
}
