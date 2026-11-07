import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./db";

export const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/** Arbitrary constant key for pg_advisory_lock, so only one process migrates at a time. */
const MIGRATION_LOCK_KEY = 4_221_337;

export interface MigrateOptions {
  dir?: string;
  log?: (msg: string) => void;
  /**
   * Hold a Postgres advisory lock while migrating, so several app instances starting at once
   * (e.g. several server processes) don't race. Disable only for databases without advisory locks (pg-mem).
   */
  lock?: boolean;
}

/** Applies every .sql file in migrations/ that hasn't been applied yet, in filename order, each in its own transaction. */
export async function migrate(db: Database, { dir = MIGRATIONS_DIR, log = () => {}, lock = true }: MigrateOptions = {}) {
  const client = await db.connect();
  try {
    if (lock) await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    if (lock) await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

if (require.main === module) {
  // Only the database connection is needed to migrate, so don't require the full app config.
  require("dotenv/config");
  const { createPool } = require("./db") as typeof import("./db");
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error("Set DATABASE_URL (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE)");
    process.exit(1);
  }
  const db = createPool(process.env.DATABASE_URL);
  migrate(db, { log: console.log })
    .then(() => console.log("migrations up to date"))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}
