import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "—";
}

export default async function DashboardPage() {
  const [providers, calls] = await Promise.all([
    prisma.provider.findMany({
      include: { lines: true, syncCursors: { orderBy: { updatedAt: "desc" } } },
      orderBy: { slug: "asc" },
    }),
    prisma.call.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { provider: true } }),
  ]);

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Call Vault</h1>
      <p style={{ color: "#9aa1af", marginTop: 0, marginBottom: 24 }}>
        Provider-agnostic call/audio storage. The worker process (see README) is what syncs from
        providers — this page is read-only.
      </p>

      <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: "0.04em", color: "#9aa1af" }}>
        Providers
      </h2>
      <table style={{ marginBottom: 32 }}>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Status</th>
            <th>Lines</th>
            <th>Last sync</th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => {
            const cursor = p.syncCursors[0];
            return (
              <tr key={p.id}>
                <td>{p.displayName}</td>
                <td>
                  <span className={`badge ${p.isActive ? "badge-ok" : "badge-off"}`}>
                    {p.isActive ? "active" : "inactive"}
                  </span>
                </td>
                <td>{p.lines.length}</td>
                <td>{cursor ? fmt(cursor.lastSyncAt) : "never"}</td>
                <td>
                  {cursor?.lastError ? <span className="badge badge-warn">{cursor.lastError}</span> : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: "0.04em", color: "#9aa1af" }}>
        Recent calls
      </h2>
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>Provider</th>
            <th>From</th>
            <th>To</th>
            <th>Dur</th>
            <th>Recording</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id}>
              <td>{fmt(c.startedAt)}</td>
              <td>{c.provider.displayName}</td>
              <td>{c.fromNumber}</td>
              <td>{c.toNumber}</td>
              <td>{c.durationSec}s</td>
              <td>
                <span
                  className={`badge ${
                    c.recordingStatus === "STORED" ? "badge-ok" : c.recordingStatus === "FAILED" ? "badge-warn" : "badge-off"
                  }`}
                >
                  {c.recordingStatus.toLowerCase()}
                </span>
              </td>
              <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>{c.aiSummary ?? "—"}</td>
            </tr>
          ))}
          {calls.length === 0 && (
            <tr>
              <td colSpan={7} style={{ color: "#9aa1af" }}>
                No calls synced yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
