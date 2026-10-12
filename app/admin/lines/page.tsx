import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { Shell } from "@/components/Shell";
import { SecretForm } from "../SecretForm";
import { addLine, updateLine } from "../actions";

export const dynamic = "force-dynamic";

const fmt = (d: Date | null | undefined) => (d ? d.toISOString().replace("T", " ").slice(0, 16) : "—");
const SOURCE: Record<string, string> = { env: "configuration", crm: "profil SDR du CRM", admin: "ajouté ici" };

export default async function LinesPage() {
  const user = await requireAdmin();
  const lines = await prisma.line.findMany({
    orderBy: { externalNumber: "asc" },
    include: { syncCursors: true, clients: { select: { client: { select: { id: true, name: true } } } }, _count: { select: { calls: true } } },
  });

  return (
    <Shell user={user} active="lines">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Numéros du compte Allo</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Tous les numéros synchronisés. Un numéro n&apos;est visible par un client que si vous le lui attribuez (page du client). Un numéro sans client reste
        réservé à Suzali Conseil.
      </p>
      <table>
        <thead>
          <tr>
            <th>Numéro</th>
            <th>Libellé</th>
            <th>Origine</th>
            <th>Appels</th>
            <th>Dernière synchro</th>
            <th>Visible par</th>
            <th>Actif</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>{l.externalNumber}</td>
              <td colSpan={1}>
                <form action={updateLine} id={`f-${l.id}`}>
                  <input type="hidden" name="lineId" value={l.id} />
                  <input name="label" aria-label={`Libellé de ${l.externalNumber}`} defaultValue={l.label ?? ""} placeholder="ex. Équipe Orpi" style={{ width: 170 }} />
                </form>
              </td>
              <td>{SOURCE[l.source] ?? l.source}</td>
              <td>{l._count.calls}</td>
              <td>{fmt(l.syncCursors[0]?.lastSyncAt)}</td>
              <td>{l.clients.length ? l.clients.map((c) => c.client.name).join(", ") : <span className="muted">Suzali uniquement</span>}</td>
              <td>
                <input form={`f-${l.id}`} type="checkbox" name="active" aria-label={`${l.externalNumber} actif`} defaultChecked={l.isActive} />
              </td>
              <td>
                <button form={`f-${l.id}`} type="submit" className="ghost">
                  Enregistrer
                </button>
              </td>
            </tr>
          ))}
          {lines.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                Aucun numéro.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 style={{ fontSize: 14, marginTop: 32 }}>Ajouter un numéro</h2>
      <SecretForm action={addLine} submit="Ajouter">
        <input name="number" aria-label="Numéro" placeholder="+33 6 12 34 56 78" required style={{ width: 200 }} />
        <input name="label" aria-label="Libellé" placeholder="Libellé (optionnel)" style={{ width: 200 }} />
      </SecretForm>
    </Shell>
  );
}
