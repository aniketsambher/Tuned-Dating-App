import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { requireAuth } from "./auth/middleware";
import type { Config } from "./config";
import { TokenCipher } from "./crypto";
import type { Database } from "./db";
import { HttpError } from "./errors";
import { authRoutes } from "./routes/auth";
import { matchingRoutes } from "./routes/matching";
import { meRoutes } from "./routes/me";
import { AuthService } from "./services/auth";
import { LikeService } from "./services/likes";
import { MatchingService } from "./services/matching";
import { SpotifyTokenService } from "./services/spotifyTokens";
import { TasteSyncService } from "./services/tasteSync";
import type { SpotifyClient } from "./spotify/client";

/** Resolves to <project>/public from both src/ (dev, tests) and dist/ (production). */
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

export interface AppDeps {
  db: Database;
  spotify: SpotifyClient;
  config: Pick<Config, "nodeEnv" | "jwtSecret" | "tokenEncryptionKey" | "appRedirectUrl" | "matchWeights">;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

export function createApp({ db, spotify, config, now = Date.now, log = console.error }: AppDeps) {
  const cipher = new TokenCipher(config.tokenEncryptionKey);
  const tokens = new SpotifyTokenService(db, spotify, cipher, now);
  const tasteSync = new TasteSyncService(db, spotify, tokens, now);
  const auth = new AuthService(db, spotify, tokens, tasteSync, config.jwtSecret, log);
  const matching = new MatchingService(db, config.matchWeights);
  const likes = new LikeService(db, matching);

  const app = express();
  app.disable("x-powered-by");
  // If run behind a reverse proxy, trust X-Forwarded-* so req.secure and req.ip are correct.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "16kb" }));
  app.use(cookieParser());

  // The web UI only loads its own files, plus profile pictures from Spotify's image CDN.
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https://*.scdn.co https://*.spotifycdn.com data:; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // Web UI (public/): a single page at "/" that talks to the JSON API below.
  app.use(express.static(PUBLIC_DIR, { index: "index.html", maxAge: config.nodeEnv === "production" ? "1h" : 0 }));

  // Load balancer health check. Also confirms the database is reachable.
  app.get("/health", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use(
    "/auth",
    authRoutes(auth, { secureCookies: config.nodeEnv === "production", appRedirectUrl: config.appRedirectUrl }),
  );

  const authed = requireAuth(config.jwtSecret);
  app.use("/me", authed, meRoutes(db, tasteSync));
  app.use(["/discover", "/likes", "/passes", "/matches"], authed);
  app.use(matchingRoutes(matching, likes));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Route not found" } });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: "invalid_request",
          message: "Request validation failed",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    // Malformed JSON body from express.json().
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON" } });
    }
    log("unhandled error", err);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong" } });
  };
  app.use(onError);

  return app;
}
