// Re-mirrors recordings for calls whose audio may have landed on a non-persistent storage path
// (e.g. STORAGE_PROVIDER=local before it was pointed at MinIO). Re-derives the provider's original
// recording URL from the already-stored rawPayload — this never re-queries WithAllo's call list,
// so it carries zero 429 risk regardless of how many calls it processes.
//
// NOTE: the sync only re-reads calls inside its lookback window (lib/sync/walk.ts), and the
// recording-mirror queue gives up after RECORDING_MIRROR_ATTEMPTS — so FAILED rows older than the
// window are never retried automatically. This script is the manual retry for those.
//
// Usage:
//   npm run remirror-recordings                    # re-mirrors STORED + FAILED (the default)
//   npm run remirror-recordings -- --status=FAILED  # only retry ones that already failed once

import "dotenv/config";
import { RecordingStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { mirrorRecording } from "../lib/audio/mirror-recording";
import { getRecordingAuthHeaders, recordingUrlFromPayload } from "../lib/providers/recordings";

async function main() {
  const statusArg = process.argv.find((a) => a.startsWith("--status="));
  const validStatuses = new Set(Object.values(RecordingStatus));
  const statuses = (statusArg ? statusArg.split("=")[1]! : "STORED,FAILED")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is RecordingStatus => validStatuses.has(s as RecordingStatus));

  if (statuses.length === 0) {
    console.error(`No valid --status values. Choose from: ${[...validStatuses].join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const calls = await prisma.call.findMany({
    where: { recordingStatus: { in: statuses } },
    include: { provider: true },
  });

  console.log(`Found ${calls.length} call(s) with status in [${statuses.join(", ")}] to re-mirror.`);

  let stored = 0;
  let failed = 0;
  let skipped = 0;

  for (const call of calls) {
    const recordingUrl = recordingUrlFromPayload(call.provider.slug, call.rawPayload);
    if (!recordingUrl) {
      console.warn(`  skip ${call.id} — no recording URL in rawPayload`);
      skipped += 1;
      continue;
    }

    const mirrored = await mirrorRecording({
      recordingUrl,
      providerSlug: call.provider.slug,
      callId: call.id,
      headers: getRecordingAuthHeaders(call.provider.slug),
    });
    if (mirrored) {
      await prisma.call.update({
        where: { id: call.id },
        data: { recordingKey: mirrored.key, recordingStatus: "STORED" },
      });
      stored += 1;
    } else {
      await prisma.call.update({ where: { id: call.id }, data: { recordingStatus: "FAILED" } });
      console.warn(`  failed ${call.id} — provider URL may have expired`);
      failed += 1;
    }
  }

  console.log(`Done. stored=${stored} failed=${failed} skipped=${skipped}`);
  if (failed > 0) {
    console.log(
      `${failed} call(s) failed re-mirroring — likely WithAllo's recording_url expired. ` +
        `Those calls still have a summary/transcription if WithAllo provided one; only the audio itself is unrecoverable.`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
