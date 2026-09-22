// Mints an API key for a service that needs to call this vault (currently: the CRM's GET
// /api/calls + GET /api/calls/:id/recording — both checked against the same "/api/calls" prefix,
// see lib/api-keys.ts's validateApiKey).
//
// Usage: npm run mint-api-key -- captainprospect-crm
// Run this wherever DATABASE_URL points at the vault's real (production) Postgres — the key is
// shown once, on stdout, and only its SHA-256 hash is stored.

import "dotenv/config";
import { generateApiKey } from "../lib/api-keys";
import { prisma } from "../lib/db";

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error("Usage: npm run mint-api-key -- <name>  (e.g. captainprospect-crm)");
    process.exitCode = 1;
    return;
  }

  const { fullKey, keyHash, keyPrefix } = generateApiKey();
  await prisma.apiKey.create({
    data: { name, keyHash, keyPrefix, allowedEndpoints: ["/api/calls"] },
  });

  console.log(`\nAPI key for "${name}" — copy it now, it will not be shown again:\n`);
  console.log(fullKey);
  console.log("");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
