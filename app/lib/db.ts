import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Lazily-initialised Neon SQL tag. Uses the HTTP driver (no persistent
 * socket), which fits Vercel's serverless/Fluid runtime. Server-only —
 * `DATABASE_URL` is never exposed to the browser.
 */
let _sql: NeonQueryFunction<false, false> | null = null;

export function getSql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) {
      throw new Error("DATABASE_URL is not set — the Points system requires a Postgres database.");
    }
    _sql = neon(url);
  }
  return _sql;
}

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
