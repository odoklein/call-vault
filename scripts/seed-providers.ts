// Seeds the 5 Provider rows and, for Allo, one Line per number in ALLO_NUMBERS.
// Run once per environment: npm run seed:providers

import "dotenv/config";
import { prisma } from "../lib/db";

const PROVIDERS = [
  { slug: "allo", displayName: "WithAllo", isActive: true },
  { slug: "leexi", displayName: "Leexi", isActive: false },
  { slug: "twilio", displayName: "Twilio", isActive: false },
  { slug: "aircall", displayName: "Aircall", isActive: false },
  { slug: "ringover", displayName: "Ringover", isActive: false },
];

async function main() {
  for (const p of PROVIDERS) {
    await prisma.provider.upsert({
      where: { slug: p.slug },
      create: p,
      update: { displayName: p.displayName },
    });
  }
  console.log(`Seeded ${PROVIDERS.length} providers.`);

  const alloNumbers = (process.env.ALLO_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  if (alloNumbers.length === 0) {
    console.log("No ALLO_NUMBERS set — skipping line seeding.");
    return;
  }

  const alloProvider = await prisma.provider.findUniqueOrThrow({ where: { slug: "allo" } });
  for (const externalNumber of alloNumbers) {
    await prisma.line.upsert({
      where: { providerId_externalNumber: { providerId: alloProvider.id, externalNumber } },
      create: { providerId: alloProvider.id, externalNumber, isActive: true },
      update: { isActive: true },
    });
  }
  console.log(`Seeded ${alloNumbers.length} Allo line(s): ${alloNumbers.join(", ")}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
