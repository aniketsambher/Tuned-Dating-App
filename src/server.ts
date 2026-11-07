import { createApp } from "./app";
import { loadConfig } from "./config";
import { createPool } from "./db";
import { migrate } from "./migrate";
import { HttpSpotifyClient } from "./spotify/client";

async function main() {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);

  // In production every task migrates on boot; an advisory lock makes concurrent starts safe.
  if (config.runMigrations) await migrate(db, { log: (m) => console.log(`migrate: ${m}`) });

  const app = createApp({ db, spotify: new HttpSpotifyClient(config.spotify), config });
  const server = app.listen(config.port, () => {
    console.log(`tuned listening on :${config.port} (${config.nodeEnv})`);
  });

  // On Ctrl+C or SIGTERM (e.g. docker stop): finish in-flight requests, then close the pool.
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      db.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("failed to start", err);
  process.exit(1);
});
