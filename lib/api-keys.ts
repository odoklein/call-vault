// Same shape as captainprospect-crm's lib/api-keys.ts (generate/hash/validate against an ApiKey
// table with keyHash + rate limit fields), without the Client/Mission/UserRole scoping — this app
// doesn't have those concepts. Used for both directions: CRM -> vault (lookups) and, later,
// vault -> CRM (webhook delivery, P1).

import crypto from "crypto";
import { prisma } from "./db";

const KEY_PREFIX = "vault_live_";

export function generateApiKey(): { fullKey: string; keyHash: string; keyPrefix: string } {
  const random = crypto.randomBytes(24).toString("hex");
  const fullKey = `${KEY_PREFIX}${random}`;
  const keyHash = crypto.createHash("sha256").update(fullKey).digest("hex");
  return { fullKey, keyHash, keyPrefix: fullKey.substring(0, 12) };
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export interface ValidatedApiKey {
  id: string;
  name: string;
  allowedEndpoints: string[];
}

export async function validateApiKey(rawKey: string | null, endpoint: string): Promise<ValidatedApiKey | null> {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;

  const keyHash = hashApiKey(rawKey);
  const key = await prisma.apiKey.findUnique({ where: { keyHash } });
  if (!key || !key.isActive) return null;
  if (key.expiresAt && key.expiresAt < new Date()) return null;

  const allowed = Array.isArray(key.allowedEndpoints) ? (key.allowedEndpoints as string[]) : [];
  if (allowed.length > 0 && !allowed.some((pattern) => endpoint.startsWith(pattern))) return null;

  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });

  return { id: key.id, name: key.name, allowedEndpoints: allowed };
}
