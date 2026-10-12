import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { Shell } from "@/components/Shell";
import { SecretForm } from "../../SecretForm";
import { createClientApiKey, createClientUser, resetUserPassword, revokeApiKey, setClientActive, setClientLines, setUserActive } from "../../actions";

export const dynamic = "force-dynamic";

const fmt = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 16) : "—");

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin();
  const { id } = await params;
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      lines: { select: { lineId: true } },
      users: { orderBy: { email: "asc" } },
      apiKeys: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!client) notFound();

  const allLines = await prisma.line.findMany({
    orderBy: { externalNumber: "asc" },
    include: { clients: { select: { clientId: true, client: { select: { name: true } } } } },
  });
  const granted = new Set(client.lines.map((l) => l.lineId));

  return (
    <Shell user={user} active="clients">
      <p className="muted" style={{ margin: 0 }}>
        <Link href="/admin/clients">← Clients</Link>
      </p>
      <h1 style={{ fontSize: 20, margin: "4px 0" }}>
        {client.name} <span className={`badge ${client.isActive ? "badge-ok" : "badge-off"}`}>{client.isActive ? "actif" : "désactivé"}</span>
      </h1>
      <div className="inline-form" style={{ marginTop: 0 }}>
        <Link className="btn ghost" href={`/board?client=${client.id}`}>
          Voir ce que voit ce client
        </Link>
        <form action={setClientActive}>
          <input type="hidden" name="clientId" value={client.id} />
          <input type="hidden" name="active" value={String(!client.isActive)} />
          <button type="submit" className={client.isActive ? "danger" : ""}>
            {client.isActive ? "Désactiver (déconnecte ses utilisateurs, bloque ses clés)" : "Réactiver"}
          </button>
        </form>
      </div>

      <h2 style={{ fontSize: 14, marginTop: 28 }}>Numéros visibles par ce client</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Cochez les numéros du compte Allo que {client.name} peut consulter (historique et appels futurs). Un numéro décoché est invisible
        pour lui, y compris ses enregistrements et transcriptions.
      </p>
      <form action={setClientLines}>
        <input type="hidden" name="clientId" value={client.id} />
        <div className="grid2">
          {allLines.map((l) => {
            const others = l.clients.filter((c) => c.clientId !== client.id).map((c) => c.client.name);
            return (
              <label key={l.id} className={`pick ${granted.has(l.id) ? "on" : ""}`}>
                <input type="checkbox" name="lineId" value={l.id} defaultChecked={granted.has(l.id)} />
                <span>
                  <b>{l.externalNumber}</b>
                  {l.label ? ` · ${l.label}` : ""}
                  {!l.isActive && <span className="muted"> · inactif</span>}
                  {others.length > 0 && <span className="muted" style={{ display: "block" }}>aussi visible par : {others.join(", ")}</span>}
                </span>
              </label>
            );
          })}
          {allLines.length === 0 && (
            <p className="muted">
              Aucun numéro. Ajoutez-les dans <Link href="/admin/lines">Numéros</Link>.
            </p>
          )}
        </div>
        <button type="submit">Enregistrer les numéros</button>
      </form>

      <h2 style={{ fontSize: 14, marginTop: 32 }}>Utilisateurs (accès au tableau de bord)</h2>
      <table>
        <thead>
          <tr>
            <th>Nom</th>
            <th>Email</th>
            <th>Dernière connexion</th>
            <th>Statut</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {client.users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{fmt(u.lastLoginAt)}</td>
              <td>
                <span className={`badge ${u.isActive ? "badge-ok" : "badge-off"}`}>{u.isActive ? "actif" : "désactivé"}</span>
              </td>
              <td>
                <form action={setUserActive} style={{ display: "inline" }}>
                  <input type="hidden" name="userId" value={u.id} />
                  <input type="hidden" name="active" value={String(!u.isActive)} />
                  <button type="submit" className="ghost">
                    {u.isActive ? "Désactiver" : "Réactiver"}
                  </button>
                </form>
                <SecretForm action={resetUserPassword} submit="Nouveau mot de passe">
                  <input type="hidden" name="userId" value={u.id} />
                </SecretForm>
              </td>
            </tr>
          ))}
          {client.users.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Aucun utilisateur.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <SecretForm action={createClientUser} submit="Créer l'utilisateur">
        <input type="hidden" name="clientId" value={client.id} />
        <input name="name" aria-label="Nom" placeholder="Nom" style={{ width: 160 }} />
        <input name="email" type="email" aria-label="Email" placeholder="email" required style={{ width: 240 }} />
      </SecretForm>

      <h2 style={{ fontSize: 14, marginTop: 32 }}>Clés API</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Pour qu&apos;un système (ex. le MCP de Captain Prospect) lise les appels de ce client : mêmes endpoints <code>/api/calls*</code>, limités aux numéros ci-dessus.
      </p>
      <table>
        <thead>
          <tr>
            <th>Nom</th>
            <th>Préfixe</th>
            <th>Dernier usage</th>
            <th>Statut</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {client.apiKeys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>
                <code>{k.keyPrefix}…</code>
              </td>
              <td>{fmt(k.lastUsedAt)}</td>
              <td>
                <span className={`badge ${k.isActive ? "badge-ok" : "badge-off"}`}>{k.isActive ? "active" : "révoquée"}</span>
              </td>
              <td>
                {k.isActive && (
                  <form action={revokeApiKey}>
                    <input type="hidden" name="keyId" value={k.id} />
                    <button type="submit" className="danger">
                      Révoquer
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <SecretForm action={createClientApiKey} submit="Créer une clé">
        <input type="hidden" name="clientId" value={client.id} />
        <input name="name" aria-label="Nom de la clé" placeholder="Nom (ex. MCP production)" style={{ width: 240 }} />
      </SecretForm>
    </Shell>
  );
}
