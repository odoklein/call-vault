// Import call history (transcripts, summaries, recordings) back to a date, for every active line.
//
// This only *marks* lines for backfill — it calls no provider itself. The worker then walks history
// SYNC_BACKFILL_PAGES_PER_RUN pages per line per sync tick, through the same single rate-limited
// queue as live sync (so it can't cause 429s), resuming from SyncCursor.backfillNextPage after any
// restart. Progress is visible on the dashboard and in GET /api/calls/coverage.
//
// Usage:
//   npm run backfill -- --days=31                  # every active line, last 31 days
//   npm run backfill -- --since=2026-09-01
//   npm run backfill -- --days=31 --line=+33612345678

import "dotenv/config";
import { prisma } from "../lib/db";
import { toE164 } from "../lib/phone";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main() {
  const days = arg("days");
  const since = arg("since");
  const lineFilter = arg("line");

  const until = since ? new Date(since) : days ? new Date(Date.now() - parseInt(days, 10) * 86_400_000) : null;
  if (!until || Number.isNaN(until.getTime())) {
    console.error("Usage: npm run backfill -- --days=31 | --since=YYYY-MM-DD [--line=+33…]");
    process.exitCode = 1;
    return;
  }

  const lines = await prisma.line.findMany({ where: { isActive: true, provider: { isActive: true } }, include: { provider: true } });
  const wantedLine = lineFilter ? toE164(lineFilter) : null;
  const targets = wantedLine ? lines.filter((l) => toE164(l.externalNumber) === wantedLine) : lines;

  if (targets.length === 0) {
    console.error(lineFilter ? `No active line matches ${lineFilter}.` : "No active lines. Run npm run seed:providers first.");
    process.exitCode = 1;
    return;
  }

  for (const line of targets) {
    await prisma.syncCursor.upsert({
      where: { providerId_lineId: { providerId: line.providerId, lineId: line.id } },
      create: { providerId: line.providerId, lineId: line.id, backfillUntil: until, backfillNextPage: 0, backfillDoneAt: null },
      update: { backfillUntil: until, backfillNextPage: 0, backfillDoneAt: null },
    });
    console.log(`  ${line.provider.slug} ${line.externalNumber}${line.crmUserId ? ` (CRM user ${line.crmUserId})` : ""}`);
  }

  console.log(
    `\nMarked ${targets.length} line(s) for backfill down to ${until.toISOString()}.\n` +
      `The running worker picks this up on its next ticks — watch progress on the dashboard or GET /api/calls/coverage.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
