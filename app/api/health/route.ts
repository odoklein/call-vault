import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isRedisAvailable, checkRedisOnce } from "@/lib/queue/redis";

export async function GET() {
  await checkRedisOnce();

  let dbOk = true;
  try {
    await prisma.provider.count();
  } catch {
    dbOk = false;
  }

  const ok = dbOk && isRedisAvailable();
  return NextResponse.json({ ok, db: dbOk, redis: isRedisAvailable() }, { status: ok ? 200 : 503 });
}
