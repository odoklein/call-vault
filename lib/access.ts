// THE access rule of the vault, in one place:
//   an admin (operator) sees every call;
//   a client — through its web users or its API keys — sees exactly the calls of the lines granted
//   to it in ClientLine. No grant, nothing. Calls not attributed to a line are admin-only.
// Every board page, media route and API route resolves a Viewer here and filters with it.

import { prisma } from "./db";

export type Viewer =
  | { kind: "admin" }
  | { kind: "client"; clientId: string; clientName: string; lineIds: string[] };

export async function viewerForClient(clientId: string): Promise<Viewer | null> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, isActive: true, lines: { select: { lineId: true } } },
  });
  if (!client || !client.isActive) return null;
  return { kind: "client", clientId: client.id, clientName: client.name, lineIds: client.lines.map((l) => l.lineId) };
}

export async function viewerForUser(user: { role: "ADMIN" | "CLIENT"; clientId: string | null }): Promise<Viewer | null> {
  if (user.role === "ADMIN") return { kind: "admin" };
  return user.clientId ? viewerForClient(user.clientId) : null;
}

/** API key: no client = operator key (every line); otherwise that client's grants. */
export async function viewerForApiKey(key: { clientId: string | null }): Promise<Viewer | null> {
  return key.clientId ? viewerForClient(key.clientId) : { kind: "admin" };
}

/** Line ids to restrict to, or undefined for "every line". */
export function visibleLineIds(viewer: Viewer): string[] | undefined {
  return viewer.kind === "admin" ? undefined : viewer.lineIds;
}

export function canSeeLine(viewer: Viewer, lineId: string | null): boolean {
  if (viewer.kind === "admin") return true;
  return lineId !== null && viewer.lineIds.includes(lineId);
}
