// Credential check with per-account lockout. Same error for unknown email / wrong password / locked,
// and the same scrypt cost in every case, so the form can't be used to discover accounts.

import { prisma } from "../db";
import { DUMMY_HASH, verifyPassword } from "./password";

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

export async function checkCredentials(emailRaw: string, password: string): Promise<{ id: string } | null> {
  const email = emailRaw.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !user.isActive) return null;
  if (user.lockedUntil && user.lockedUntil > new Date()) return null;

  if (!ok) {
    const fails = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: fails >= MAX_FAILS ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } : { failedLogins: fails },
    });
    return null;
  }

  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  return { id: user.id };
}
