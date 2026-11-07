import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  // Either a full DATABASE_URL, or the standard PGHOST/PGUSER/PGPASSWORD/PGDATABASE variables
  DATABASE_URL: z.string().optional(),
  PGHOST: z.string().optional(),
  RUN_MIGRATIONS: z.stringbool().default(false),
  SPOTIFY_CLIENT_ID: z.string().min(1),
  SPOTIFY_CLIENT_SECRET: z.string().min(1),
  SPOTIFY_REDIRECT_URI: z.url(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  APP_REDIRECT_URL: z.union([z.url(), z.literal("")]).default(""),
  MATCH_ARTIST_WEIGHT: z.coerce.number().nonnegative().default(0.6),
  MATCH_GENRE_WEIGHT: z.coerce.number().nonnegative().default(0.4),
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  /** Undefined means "use the PG* environment variables". */
  databaseUrl: string | undefined;
  runMigrations: boolean;
  spotify: { clientId: string; clientSecret: string; redirectUri: string };
  jwtSecret: string;
  tokenEncryptionKey: string;
  appRedirectUrl: string;
  matchWeights: { artists: number; genres: number };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  if (!e.DATABASE_URL && !e.PGHOST) {
    throw new Error("Invalid environment configuration:\n  DATABASE_URL: set DATABASE_URL or PGHOST");
  }
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    runMigrations: e.RUN_MIGRATIONS,
    spotify: {
      clientId: e.SPOTIFY_CLIENT_ID,
      clientSecret: e.SPOTIFY_CLIENT_SECRET,
      redirectUri: e.SPOTIFY_REDIRECT_URI,
    },
    jwtSecret: e.JWT_SECRET,
    tokenEncryptionKey: e.TOKEN_ENCRYPTION_KEY,
    appRedirectUrl: e.APP_REDIRECT_URL,
    matchWeights: { artists: e.MATCH_ARTIST_WEIGHT, genres: e.MATCH_GENRE_WEIGHT },
  };
}
