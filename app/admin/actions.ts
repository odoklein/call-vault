"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireAdmin, revokeSessions } from "@/lib/auth/session";
import { generatePassword, hashPassword } from "@/lib/auth/password";
import { generateApiKey } from "@/lib/api-keys";
import { toE164 } from "@/lib/phone";

export interface ActionResult {
  ok?: boolean;
  error?: string;
  /** Shown once to the admin (generated password / API key). Never stored in clear. */
  secret?: string;
  note?: string;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// ---- clients ----

export async function createClient(_prev: ActionResult, f: FormData): Promise<ActionResult> {
  await requireAdmin();
  const name = str(f, "name");
  const slug = slugify(str(f, "slug") || name);
  if (!name || !slug) return { error: "Nom requis." };
  if (await prisma.client.findUnique({ where: { slug } })) return { error: `Le client « ${slug} » existe déjà.` };
  const client = await prisma.client.create({ data: { name, slug } });
  redirect(`/admin/clients/${client.id}`);
}

export async function setClientActive(f: FormData) {
  await requireAdmin();
  const id = str(f, "clientId");
  const isActive = str(f, "active") === "true";
  await prisma.client.update({ where: { id }, data: { isActive } });
  if (!isActive) {
    const users = await prisma.user.findMany({ where: { clientId: id }, select: { id: true } });
    for (const u of users) await revokeSessions(u.id);
  }
  revalidatePath(`/admin/clients/${id}`);
  revalidatePath("/admin/clients");
}

/** Replaces the client's granted numbers with exactly the ticked ones. */
export async function setClientLines(f: FormData) {
  const admin = await requireAdmin();
  const clientId = str(f, "clientId");
  const wanted = new Set(f.getAll("lineId").map(String));
  const existing = await prisma.clientLine.findMany({ where: { clientId }, select: { lineId: true } });
  const have = new Set(existing.map((e) => e.lineId));

  const toAdd = [...wanted].filter((id) => !have.has(id));
  const toRemove = [...have].filter((id) => !wanted.has(id));
  const valid = toAdd.length ? await prisma.line.findMany({ where: { id: { in: toAdd } }, select: { id: true } }) : [];

  await prisma.$transaction([
    prisma.clientLine.deleteMany({ where: { clientId, lineId: { in: toRemove } } }),
    prisma.clientLine.createMany({ data: valid.map((l) => ({ clientId, lineId: l.id, grantedById: admin.id })) }),
  ]);
  revalidatePath(`/admin/clients/${clientId}`);
}

// ---- client users ----

export async function createClientUser(_prev: ActionResult, f: FormData): Promise<ActionResult> {
  await requireAdmin();
  const clientId = str(f, "clientId");
  const email = str(f, "email").toLowerCase();
  const name = str(f, "name") || email;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Email invalide." };
  if (await prisma.user.findUnique({ where: { email } })) return { error: "Cet email est déjà utilisé." };
  const password = generatePassword();
  await prisma.user.create({ data: { email, name, role: "CLIENT", clientId, passwordHash: await hashPassword(password) } });
  revalidatePath(`/admin/clients/${clientId}`);
  return { ok: true, secret: password, note: `Mot de passe de ${email} — affiché une seule fois.` };
}

export async function resetUserPassword(_prev: ActionResult, f: FormData): Promise<ActionResult> {
  await requireAdmin();
  const userId = str(f, "userId");
  const password = generatePassword();
  const user = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null },
  });
  await revokeSessions(userId);
  if (user.clientId) revalidatePath(`/admin/clients/${user.clientId}`);
  return { ok: true, secret: password, note: `Nouveau mot de passe de ${user.email} — affiché une seule fois.` };
}

export async function setUserActive(f: FormData) {
  await requireAdmin();
  const userId = str(f, "userId");
  const isActive = str(f, "active") === "true";
  const user = await prisma.user.update({ where: { id: userId }, data: { isActive } });
  if (!isActive) await revokeSessions(userId);
  if (user.clientId) revalidatePath(`/admin/clients/${user.clientId}`);
}

// ---- client API keys ----

export async function createClientApiKey(_prev: ActionResult, f: FormData): Promise<ActionResult> {
  await requireAdmin();
  const clientId = str(f, "clientId");
  const name = str(f, "name") || "Clé API";
  const { fullKey, keyHash, keyPrefix } = generateApiKey();
  await prisma.apiKey.create({ data: { name, keyHash, keyPrefix, clientId, allowedEndpoints: ["/api/calls"] } });
  revalidatePath(`/admin/clients/${clientId}`);
  return { ok: true, secret: fullKey, note: "Clé API — affichée une seule fois." };
}

export async function revokeApiKey(f: FormData) {
  await requireAdmin();
  const key = await prisma.apiKey.update({ where: { id: str(f, "keyId") }, data: { isActive: false } });
  if (key.clientId) revalidatePath(`/admin/clients/${key.clientId}`);
}

// ---- lines (the Allo numbers) ----

export async function addLine(_prev: ActionResult, f: FormData): Promise<ActionResult> {
  await requireAdmin();
  const number = toE164(str(f, "number"));
  if (!number) return { error: "Numéro invalide." };
  const allo = await prisma.provider.findUnique({ where: { slug: "allo" } });
  if (!allo) return { error: "Fournisseur Allo absent : lancez npm run seed:providers." };
  const label = str(f, "label") || null;
  await prisma.line.upsert({
    where: { providerId_externalNumber: { providerId: allo.id, externalNumber: number } },
    create: { providerId: allo.id, externalNumber: number, label, source: "admin", isActive: true },
    update: { label: label ?? undefined, isActive: true },
  });
  revalidatePath("/admin/lines");
  return { ok: true, note: `${number} ajouté — la synchronisation démarre au prochain passage du worker (≤ 5 min).` };
}

export async function updateLine(f: FormData) {
  await requireAdmin();
  const id = str(f, "lineId");
  await prisma.line.update({ where: { id }, data: { label: str(f, "label") || null, isActive: f.get("active") === "on" } });
  revalidatePath("/admin/lines");
}
