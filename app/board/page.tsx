import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { viewerForClient, viewerForUser, visibleLineIds, type Viewer } from "@/lib/access";
import { Shell } from "@/components/Shell";
import { PERIODS, boardByLineQuery, boardTotalsQuery, periodRange, type BoardLineRow, type BoardTotals } from "@/lib/board";
import { callSearchQuery, paginate, type CallSearchRow } from "@/lib/calls/search";

export const dynamic = "force-dynamic";

const PAGE = 25;
const fmtDate = (iso: string) => iso.replace("T", " ").slice(0, 16);
const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}` : `${s}s`);
const fmtTalk = (s: number) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");

type SP = { q?: string; period?: string; line?: string; transcript?: string; cursor?: string; client?: string };

export default async function BoardPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const sp = await searchParams;

  // An admin can preview exactly what one client sees (?client=…); otherwise admins see every line.
  let viewer: Viewer | null;
  let previewName: string | null = null;
  if (user.role === "ADMIN" && sp.client) {
    viewer = await viewerForClient(sp.client);
    if (!viewer) notFound();
    previewName = viewer.kind === "client" ? viewer.clientName : null;
  } else {
    viewer = await viewerForUser(user);
  }
  if (!viewer) notFound();

  const lineIds = visibleLineIds(viewer);
  const { key: period, from } = periodRange(sp.period);
  // A line filter may only narrow within what the viewer can already see.
  const selectedLine = sp.line && (!lineIds || lineIds.includes(sp.line)) ? sp.line : undefined;
  const searchLineIds = selectedLine ? [selectedLine] : lineIds;

  const [totalsRows, byLine, rows] = await Promise.all([
    prisma.$queryRaw<BoardTotals[]>(boardTotalsQuery(lineIds, from)),
    prisma.$queryRaw<BoardLineRow[]>(boardByLineQuery(lineIds, from)),
    prisma.$queryRaw<CallSearchRow[]>(
      callSearchQuery({
        lineIds: searchLineIds,
        q: sp.q?.trim() || undefined,
        from,
        hasTranscript: sp.transcript === "1" ? true : undefined,
        cursor: sp.cursor,
        limit: PAGE,
      }),
    ),
  ]);
  const totals = totalsRows[0] ?? { calls: 0, conversations: 0, withTranscript: 0, withRecording: 0, talkSec: 0 };
  const { items, nextCursor } = paginate(rows, PAGE);

  const qs = (over: Partial<SP>) => {
    const p = new URLSearchParams();
    const merged = { ...sp, cursor: undefined, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/board?${p.toString()}`;
  };
  const clientQs = previewName ? `&client=${sp.client}` : "";

  return (
    <Shell user={user} active="board">
      {previewName && (
        <p className="badge badge-warn" style={{ display: "block", marginBottom: 12 }}>
          Aperçu : vue de {previewName} — <Link href="/board" style={{ color: "inherit" }}>quitter</Link>
        </p>
      )}
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>{viewer.kind === "client" ? `Appels · ${viewer.clientName}` : "Appels · tous les numéros"}</h1>

      <form className="inline-form" method="get">
        {sp.client && <input type="hidden" name="client" value={sp.client} />}
        <input name="q" type="search" aria-label="Rechercher dans les transcriptions" defaultValue={sp.q ?? ""} placeholder="Rechercher dans les transcriptions…" style={{ width: 300 }} />
        <select name="period" aria-label="Période" defaultValue={period}>
          {Object.entries(PERIODS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <select name="line" aria-label="Numéro" defaultValue={selectedLine ?? ""}>
          <option value="">Tous les numéros</option>
          {byLine.map((l) => (
            <option key={l.lineId} value={l.lineId}>
              {l.label ? `${l.label} · ` : ""}
              {l.number}
            </option>
          ))}
        </select>
        <label className="muted">
          <input type="checkbox" name="transcript" value="1" defaultChecked={sp.transcript === "1"} /> avec transcription
        </label>
        <button type="submit">Filtrer</button>
      </form>

      <div className="cards">
        <div className="card"><b>{totals.calls}</b><span>appels</span></div>
        <div className="card"><b>{totals.conversations}</b><span>conversations (≥ 20 s)</span></div>
        <div className="card"><b>{pct(totals.withTranscript, totals.conversations)}</b><span>avec transcription</span></div>
        <div className="card"><b>{totals.withRecording}</b><span>enregistrements</span></div>
        <div className="card"><b>{fmtTalk(totals.talkSec)}</b><span>temps de parole</span></div>
      </div>

      {byLine.length > 0 && (
        <>
          <h2 style={{ fontSize: 14, marginTop: 24 }}>Par numéro</h2>
          <table>
            <thead>
              <tr>
                <th>Numéro</th>
                <th>Appels</th>
                <th>Conversations</th>
                <th>Transcriptions</th>
                <th>Temps de parole</th>
                <th>Dernier appel</th>
              </tr>
            </thead>
            <tbody>
              {byLine.map((l) => (
                <tr key={l.lineId}>
                  <td>
                    <Link href={qs({ line: l.lineId })}>
                      {l.label ? `${l.label} · ` : ""}
                      {l.number}
                    </Link>
                  </td>
                  <td>{l.calls}</td>
                  <td>{l.conversations}</td>
                  <td>{l.withTranscript}</td>
                  <td>{fmtTalk(l.talkSec)}</td>
                  <td>{l.lastCallAt ? fmtDate(l.lastCallAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2 style={{ fontSize: 14, marginTop: 28 }}>Appels</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Numéro</th>
            <th>Interlocuteur</th>
            <th>Durée</th>
            <th>Transcription</th>
            <th>Audio</th>
            <th>Résumé</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <Link href={`/board/calls/${c.id}${clientQs ? `?${clientQs.slice(1)}` : ""}`}>{fmtDate(c.startedAt)}</Link>
              </td>
              <td>{c.lineLabel ?? c.lineNumber ?? "—"}</td>
              <td>
                {c.direction === "INBOUND" ? "← " : "→ "}
                {c.remoteNumber ?? "—"}
              </td>
              <td>{fmtDur(c.durationSec)}</td>
              <td>{c.hasTranscript ? <span className="badge badge-ok">oui</span> : <span className="badge badge-off">non</span>}</td>
              <td>{c.hasRecording ? <span className="badge badge-ok">oui</span> : <span className="badge badge-off">non</span>}</td>
              <td style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis" }}>{c.snippet ? <Highlight text={c.snippet} /> : (c.summary ?? "—")}</td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                {lineIds && lineIds.length === 0 ? "Aucun numéro ne vous a encore été attribué. Contactez Suzali Conseil." : "Aucun appel pour ces critères."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {nextCursor && (
        <p>
          <Link className="btn ghost" href={qs({ cursor: nextCursor })}>
            Appels plus anciens →
          </Link>
        </p>
      )}
    </Shell>
  );
}

/** Renders ts_headline output: «match» becomes <mark>; everything else stays plain text (no HTML injection). */
function Highlight({ text }: { text: string }) {
  return (
    <>
      {text.split(/(«[^»]*»)/g).map((part, i) =>
        part.startsWith("«") ? <mark key={i}>{part.slice(1, -1)}</mark> : <span key={i}>{part}</span>,
      )}
    </>
  );
}
