// Server-side sessions. The cookie carries a random 32-byte token; the DB stores only its SHA-256,
// so a leaked DB dump can't be replayed as cookies. Every page and server action re-validates here —
// proxy.ts only checks that a cookie is present, to redirect anonymous visitors cheaply.

import { createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Client, User } from "@prisma/client";
import { prisma } from "../db";

export const SESSION_COOKIE = "cv_session";
const SESSION_DAYS = 14;
const TOUCH_EVERY_MS = 10 * 60_000;

export type SessionUser = Pick<User, "id" | "email" | "name" | "role" | "clientId"> & { client: Pick<Client, "id" | "name" | "slug" | "isActive"> | null };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function secureCookies(): boolean {
  return (process.env.APP_URL ?? "").startsWith("https://") || process.env.NODE_ENV === "production";
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await prisma.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(SESSION_COOKIE);
}

/** The logged-in user, or null. Inactive users and inactive clients count as logged out. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        select: {
          id: true, email: true, name: true, role: true, clientId: true, isActive: true,
          client: { select: { id: true, name: true, slug: true, isActive: true } },
        },
      },
    },
  });
  if (!session || session.expiresAt < new Date() || !session.user.isActive) return null;
  if (session.user.role === "CLIENT" && !session.user.client?.isActive) return null;

  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
  const { isActive: _active, ...user } = session.user;
  void _active;
  return user;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") redirect("/");
  return user;
}

/** Drop every session of a user (password reset, deactivation). */
export async function revokeSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}
