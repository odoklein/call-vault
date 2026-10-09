import { PrismaClient } from "@prisma/client";

declare global {
  var __callVaultPrisma: PrismaClient | undefined;
}

export const prisma = global.__callVaultPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__callVaultPrisma = prisma;
}
