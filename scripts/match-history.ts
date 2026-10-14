// Link past calls to CRM actions in one go — what the scheduled CRM sync does, but over a month
// instead of its 72h matcher window (an action older than that is otherwise never linked).
//
// Steps, same as lib/queue/crm-sync.ts: SDR numbers -> lines, CALL actions since --days, matcher
// over the same span. Safe to re-run: a match, once made, is never changed, and the watermark only
// moves forward. Calls must already be in the vault (npm run backfill first if they aren't).
//
// Usage:
//   npm run match-history                 # last 31 days
//   npm run match-history -- --days=45

import "dotenv/config";
import { prisma } from "../lib/db";
import { getCrmSource } from "../lib/crm/source";
import { syncCrmActions, syncSdrLines } from "../lib/crm/directory-sync";
import { runMatcher } from "../lib/linking/run-matcher";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main() {
  const days = parseInt(arg("days") ?? "31", 10);
  if (!Number.isFinite(days) || days < 1) {
    console.error("Usage: npm run match-history -- --days=31");
    process.exitCode = 1;
    return;
  }
  const source = getCrmSource();
  if (!source) {
    console.error("Neither CRM_API_URL + CRM_API_KEY nor CRM_DATABASE_URL is set in this environment.");
    process.exitCode = 1;
    return;
  }
  const since = new Date(Date.now() - days * 86_400_000);
  console.log(`CRM source: ${source.describe()} — linking calls since ${since.toISOString()}\n`);

  const lines = await syncSdrLines(source);
  console.log(`1. SDR lines: ${lines.mapped} mapped to an SDR`);
  if (lines.provisioned.length) console.log(`   new lines from CRM numbers: ${lines.provisioned.join(", ")}`);
  if (lines.conflicts.length) console.log(`   left unowned (number held by several active CRM users): ${lines.conflicts.join(", ")}`);

  const actions = await syncCrmActions(source, { since });
  console.log(`2. CRM call actions: ${actions.read} read, ${actions.created} new, ${actions.updated} updated`);

  const matcher = await runMatcher(new Date(), { retryWindowMs: days * 86_400_000 });
  console.log(
    `3. Matcher: ${matcher.considered} actions considered, ${matcher.matched} linked to a call, ` +
      `${matcher.unmatched} with no fitting call, ${matcher.waitingForLine} waiting for their SDR's line to sync`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
