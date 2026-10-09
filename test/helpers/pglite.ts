// In-process Postgres (PGlite) with every migration in prisma/migrations applied, in order — the
// same SQL production runs. Lets tests prove what a mock can't: the migrations apply cleanly, the
// generated full-text column works with the 'french' config, and raw queries are valid SQL.
// Same approach as captainprospect-crm's lib/api-v1/sql.pglite.test.ts.

import { readdirSync, readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import type { Prisma } from "@prisma/client";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");

export async function migratedPglite(): Promise<PGlite> {
  const pg = new PGlite();
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    await pg.exec(readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
  }
  return pg;
}

/** Runs a Prisma.sql fragment (what lib/ code hands to $queryRaw) on PGlite. */
export async function runSql<T>(pg: PGlite, sql: Prisma.Sql): Promise<T[]> {
  const values = sql.values.map((v) => (v instanceof Date ? v.toISOString() : v));
  return (await pg.query<T>(sql.text, values)).rows;
}
