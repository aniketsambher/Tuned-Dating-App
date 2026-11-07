/**
 * Runs a local PostgreSQL server without Docker, for development.
 * Data is kept in .pgdata/ between runs. Leave this running in its own terminal:
 *
 *   npm run db
 *
 * Uses port 5432 and the same credentials as docker-compose (tuned/tuned, database "tuned"),
 * so the DATABASE_URL in .env works with either one. Don't run both at once.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const dataDir = path.resolve(__dirname, "..", ".pgdata");
const port = Number(process.env.PGPORT_DEV ?? 5432);

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "tuned",
    password: "tuned",
    port,
    persistent: true,
    // On macOS/Linux the Postgres binaries need symlinks that a postinstall script normally creates.
    // Newer npm versions skip install scripts unless approved, so recreate them here if missing.
    autoRehydrateSymlinks: true,
    onLog: () => {},
  });

  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    console.log("initializing a new database in .pgdata/");
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase("tuned");
  } catch {
    // Already exists from a previous run.
  }
  console.log(`postgres ready on postgres://tuned:tuned@localhost:${port}/tuned (Ctrl+C to stop)`);

  const stop = async () => {
    console.log("stopping postgres");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("failed to start postgres:", err);
  process.exit(1);
});
