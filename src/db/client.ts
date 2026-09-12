/**
 * The only place production code creates a real database connection.
 * Repositories never import this module — they take a `Database` as a
 * plain function parameter (see repositories/*.ts), so they work
 * identically against this Neon-backed client or a PGlite instance in
 * tests, with no environment-variable trickery and no DI framework.
 *
 * Nothing here runs at import time: `getDb()` connects lazily, on first
 * call, so importing this module (or anything that transitively imports
 * it) never fails just because DATABASE_URL is unset — e.g. /api/health
 * must keep working with no DB configured at all (Phase 3 brief §3/§45).
 */
import { Pool } from "pg";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { AppError } from "@/lib/errors.ts";
import * as schema from "./schema.ts";

export type Schema = typeof schema;

/**
 * The common base type both a real Neon/Postgres connection
 * (NodePgDatabase) and a PGlite one (PgliteDatabase) are assignable to —
 * repositories are written against this, not a union of the two concrete
 * types. A union here (tried first) breaks: TypeScript resolves a method
 * chain called on a union of two structurally-different generic classes
 * against the *intersection* of their overloads, which silently collapses
 * `.returning(fields)` down to its zero-arg overload only and produces
 * confusing "Expected 0 arguments" errors several calls downstream. This
 * base-class type doesn't have that problem — see repositories/posts.ts
 * for where it actually matters (onConflictDoUpdate + returning(fields)).
 */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

let pool: Pool | undefined;
let db: NodePgDatabase<Schema> | undefined;

/** Lazily creates (once) and returns the production database client, using
 * `DATABASE_URL` (Neon's pooled connection string — see .env.example).
 * Throws AppError, does not crash the process, if it's not configured;
 * callers (a route handler, a future job) decide how to surface that. */
export function getDb(): NodePgDatabase<Schema> {
  if (db) return db;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new AppError("INTERNAL", "DATABASE_URL is not set — cannot create a database connection");
  }

  pool = new Pool({ connectionString });
  db = drizzleNodePg(pool, { schema });
  return db;
}

/** Closes the pooled connection, if one was ever created. For graceful
 * shutdown in scripts; route handlers on Vercel should not call this. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
