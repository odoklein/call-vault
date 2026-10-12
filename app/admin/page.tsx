import { prisma } from "@/lib/db";
import { getCoverage } from "@/lib/coverage";
import { requireAdmin } from "@/lib/auth/session";
import { Shell } from "@/components/Shell";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;

function fmt(d: Date | string | null): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function pct(part: number, whole: number): string {
  return whole ? `${Math.round((100 * part) / whole)}%` : "—";
}

const h2 = { fontSize: 14, textTransform: "uppercase" as const, letterSpacing: "0.04em", color: "#9aa1af", marginTop: 32 };
const muted = { color: "#9aa1af" };

function Badge({ tone, children }: { tone: "ok" | "warn" | "off"; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export default async function DashboardPage() {
  const user = await requireAdmin();
  const now = new Date();
  const [coverage, calls] = await Promise.all([
    getCoverage(new Date(now.getTime() - 7 * DAY), now, now),
    prisma.call.findMany({
      orderBy: { startedAt: "desc" },
      take: 30,
      include: { line: true, crmAction: { select: { result: true, matchConfidence: true } } },
    }),
  ]);
  const t = coverage.totals;
  const crm = coverage.crmSync;
  const problems =
    (crm && !crm.ok ? 1 : 0) +
    coverage.sdrsWithoutLine.length + coverage.lines.filter((l) => l.stale || l.lastError).length + t.missingTranscript;

  return (
    <Shell user={user} active="overview">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Vue d&apos;ensemble (opérateur)</h1>
      <p style={{ ...muted, marginTop: 0 }}>
        Last 7 days. Every call, transcript and recording from every SDR line, linked to the CRM action it records.
        Read-only — the worker process syncs; this page reports. {problems === 0 ? <Badge tone="ok">nothing missing</Badge> : <Badge tone="warn">{problems} issue(s) below</Badge>}
      </p>

      <p style={{ margin: "12px 0" }}>
        Liaison CRM :{" "}
        {!crm ? (
          <span className="badge badge-off">jamais exécutée — CRM_API_URL / CRM_API_KEY manquants sur le worker ?</span>
        ) : crm.ok ? (
          <span className="badge badge-ok">OK · {crm.source} · {fmt(crm.at)} UTC</span>
        ) : (
          <span className="badge badge-warn">en échec depuis {fmt(crm.at)} UTC : {crm.error}</span>
        )}
      </p>

      <table style={{ width: "auto" }}>
        <tbody>
          <tr>
            <th>Calls in vault</th>
            <td>{t.calls}</td>
            <th>Conversations</th>
            <td>{t.conversations}</td>
            <th>With transcript</th>
            <td>
              {t.withTranscript} ({pct(t.withTranscript, t.conversations)})
            </td>
          </tr>
          <tr>
            <th>CRM call actions</th>
            <td>{t.actions}</td>
            <th>Linked to a call</th>
            <td>
              {t.matched} ({pct(t.matched, t.actions)}) · high {t.matchedHigh}
            </td>
            <th>Unlogged conversations</th>
            <td>{t.unloggedConversations}</td>
          </tr>
        </tbody>
      </table>

      {coverage.sdrsWithoutLine.length > 0 && (
        <>
          <h2 style={h2}>SDRs whose calls are not synced</h2>
          <p style={muted}>
            These CRM users logged calls but no active vault line belongs to them — set their Allo number on their CRM profile
            (User.alloPhoneNumber); the next CRM sync provisions the line automatically.
          </p>
          <p>
            {coverage.sdrsWithoutLine.map((id) => (
              <code key={id} style={{ marginRight: 12 }}>
                {id}
              </code>
            ))}
          </p>
        </>
      )}

      <h2 style={h2}>Lines</h2>
      <table>
        <thead>
          <tr>
            <th>Number</th>
            <th>CRM user</th>
            <th>Source</th>
            <th>Status</th>
            <th>Last sync</th>
            <th>Backfill</th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody>
          {coverage.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.number}</td>
              <td>{l.sdrUserId ?? <Badge tone="warn">unmapped</Badge>}</td>
              <td>{l.source}</td>
              <td>
                {!l.isActive ? <Badge tone="off">inactive</Badge> : l.stale ? <Badge tone="warn">stale</Badge> : <Badge tone="ok">syncing</Badge>}
              </td>
              <td>{fmt(l.lastSyncAt)}</td>
              <td>
                {l.backfill
                  ? l.backfill.done
                    ? `done → ${fmt(l.backfill.until).slice(0, 10)}`
                    : `page ${l.backfill.nextPage ?? 0} → ${fmt(l.backfill.until).slice(0, 10)}`
                  : "—"}
              </td>
              <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>
                {l.lastError ? <Badge tone="warn">{l.lastError}</Badge> : "—"}
              </td>
            </tr>
          ))}
          {coverage.lines.length === 0 && (
            <tr>
              <td colSpan={7} style={muted}>
                No lines. Run npm run seed:providers, or configure CRM_DATABASE_URL to provision them from the CRM.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 style={h2}>By SDR</h2>
      <table>
        <thead>
          <tr>
            <th>CRM user</th>
            <th>CRM call actions</th>
            <th>Linked</th>
            <th>Unmatched</th>
            <th>Pending</th>
            <th>Vault calls</th>
            <th>Conversations</th>
            <th>Transcripts</th>
            <th>Missing</th>
            <th>Unlogged</th>
            <th>Rec. failed</th>
          </tr>
        </thead>
        <tbody>
          {coverage.bySdr.map((r) => (
            <tr key={r.sdrUserId}>
              <td>{r.sdrUserId}</td>
              <td>{r.actions}</td>
              <td>
                {r.matched} ({pct(r.matched, r.actions)})
              </td>
              <td>{r.unmatched || "—"}</td>
              <td>{r.pending || "—"}</td>
              <td>{r.calls}</td>
              <td>{r.conversations}</td>
              <td>
                {r.withTranscript} ({pct(r.withTranscript, r.conversations)})
              </td>
              <td>{r.missingTranscript ? <Badge tone="warn">{r.missingTranscript}</Badge> : "—"}</td>
              <td>{r.unloggedConversations || "—"}</td>
              <td>{r.recordingsFailed ? <Badge tone="warn">{r.recordingsFailed}</Badge> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={h2}>Recent calls</h2>
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>SDR</th>
            <th>Remote</th>
            <th>Dur</th>
            <th>Transcript</th>
            <th>Recording</th>
            <th>CRM link</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id}>
              <td>{fmt(c.startedAt)}</td>
              <td>{c.line?.crmUserId ?? "—"}</td>
              <td>{c.remoteNumber ?? (c.direction === "INBOUND" ? c.fromNumber : c.toNumber)}</td>
              <td>{c.durationSec}s</td>
              <td>{c.transcription ? <Badge tone="ok">yes</Badge> : <Badge tone="off">no</Badge>}</td>
              <td>
                <Badge tone={c.recordingStatus === "STORED" ? "ok" : c.recordingStatus === "FAILED" ? "warn" : "off"}>
                  {c.recordingStatus.toLowerCase()}
                </Badge>
              </td>
              <td>
                {c.crmAction ? (
                  <>
                    {c.crmAction.result} <Badge tone={c.crmAction.matchConfidence === "HIGH" ? "ok" : "warn"}>{c.crmAction.matchConfidence?.toLowerCase()}</Badge>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>{c.aiSummary ?? "—"}</td>
            </tr>
          ))}
          {calls.length === 0 && (
            <tr>
              <td colSpan={8} style={muted}>
                No calls synced yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Shell>
  );
}
