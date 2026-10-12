import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { Shell } from "@/components/Shell";
import { SecretForm } from "../SecretForm";
import { createClient } from "../actions";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const user = await requireAdmin();
  const clients = await prisma.client.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { lines: true, users: true, apiKeys: true } } },
  });

  return (
    <Shell user={user} active="clients">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Clients</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Chaque client ne voit que les numéros que vous lui attribuez. Les autres numéros du compte Allo restent invisibles pour lui.
      </p>

      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Statut</th>
            <th>Numéros attribués</th>
            <th>Utilisateurs</th>
            <th>Clés API</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id}>
              <td>
                <Link href={`/admin/clients/${c.id}`}>{c.name}</Link>
              </td>
              <td>
                <span className={`badge ${c.isActive ? "badge-ok" : "badge-off"}`}>{c.isActive ? "actif" : "désactivé"}</span>
              </td>
              <td>{c._count.lines}</td>
              <td>{c._count.users}</td>
              <td>{c._count.apiKeys}</td>
            </tr>
          ))}
          {clients.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Aucun client. Créez le premier ci-dessous (par exemple Captain Prospect CRM).
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 style={{ fontSize: 14, marginTop: 32 }}>Nouveau client</h2>
      <SecretForm action={createClient} submit="Créer">
        <input name="name" aria-label="Nom du client" placeholder="Nom (ex. Captain Prospect CRM)" required style={{ width: 280 }} />
        <input name="slug" aria-label="Identifiant" placeholder="identifiant (optionnel)" style={{ width: 180 }} />
      </SecretForm>
    </Shell>
  );
}
