import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { canSeeLine, viewerForClient, viewerForUser, type Viewer } from "@/lib/access";
import { Shell } from "@/components/Shell";
import type { TranscriptSegment } from "@/lib/providers/types";

export const dynamic = "force-dynamic";

const SPEAKER: Record<string, string> = { SDR: "Conseiller", PROSPECT: "Interlocuteur", AGENT: "Assistant IA", UNKNOWN: "?" };

export default async function CallPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ client?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;

  const viewer: Viewer | null = user.role === "ADMIN" && sp.client ? await viewerForClient(sp.client) : await viewerForUser(user);
  if (!viewer) notFound();

  const call = await prisma.call.findUnique({ where: { id }, include: { line: { select: { externalNumber: true, label: true } } } });
  // Same 404 whether the call doesn't exist or isn't on one of the viewer's lines.
  if (!call || !canSeeLine(viewer, call.lineId)) notFound();

  const segments = Array.isArray(call.transcriptSegments) ? (call.transcriptSegments as unknown as TranscriptSegment[]) : [];
  const back = sp.client ? `/board?client=${sp.client}` : "/board";

  return (
    <Shell user={user} active="board">
      <p className="muted" style={{ margin: 0 }}>
        <Link href={back}>← Appels</Link>
      </p>
      <h1 style={{ fontSize: 20, margin: "4px 0" }}>
        {call.direction === "INBOUND" ? "Appel reçu de" : "Appel vers"} {call.remoteNumber ?? "—"}
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {call.startedAt?.toISOString().replace("T", " ").slice(0, 16)} UTC · {call.durationSec}s · numéro {call.line?.label ?? call.line?.externalNumber ?? "—"}
      </p>

      {call.recordingStatus === "STORED" && (
        <audio controls preload="none" src={`/media/calls/${call.id}`} style={{ width: "100%", maxWidth: 560, margin: "8px 0" }} />
      )}

      {call.aiSummary && (
        <>
          <h2 style={{ fontSize: 14 }}>Résumé</h2>
          <div className="card" style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.5 }}>{call.aiSummary}</div>
        </>
      )}

      <h2 style={{ fontSize: 14, marginTop: 24 }}>Transcription</h2>
      {segments.length > 0 ? (
        segments.map((s, i) => (
          <div key={i} className={`turn ${s.speaker}`}>
            <small>{SPEAKER[s.speaker] ?? s.speaker}</small>
            {s.text}
          </div>
        ))
      ) : call.transcription ? (
        <div className="card" style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{call.transcription}</div>
      ) : (
        <p className="muted">Pas de transcription pour cet appel.</p>
      )}
    </Shell>
  );
}
