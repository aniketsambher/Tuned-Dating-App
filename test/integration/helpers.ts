import path from "node:path";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import request from "supertest";
import { expect } from "vitest";
import { createApp } from "../../src/app";
import type { Database } from "../../src/db";
import { HttpError } from "../../src/errors";
import { migrate } from "../../src/migrate";
import type { SpotifyArtist, SpotifyClient, SpotifyProfile, SpotifyTokens } from "../../src/spotify/client";

export const TEST_CONFIG = {
  nodeEnv: "test" as const,
  jwtSecret: "test-jwt-secret-that-is-at-least-32-chars",
  tokenEncryptionKey: "test-encryption-key",
  appRedirectUrl: "",
  matchWeights: { artists: 0.6, genres: 0.4 },
};

const MIGRATIONS = path.resolve(__dirname, "../../migrations");

/**
 * A fresh, migrated database. Uses real Postgres when TEST_DATABASE_URL is set (CI does this),
 * otherwise an in-memory pg-mem instance so the suite runs with no setup.
 * Note: pg-mem doesn't roll back transactions or take row locks, so tests here must not depend on either.
 */
export async function createTestDb(): Promise<Database> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const pool = new Pool({ connectionString: url });
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(pool, { dir: MIGRATIONS });
    return pool;
  }
  const mem = newDb();
  const { Pool: MemPool } = mem.adapters.createPg();
  const pool = new MemPool() as unknown as Database;
  await migrate(pool, { dir: MIGRATIONS, lock: false });
  return pool;
}

export const usingRealPostgres = () => Boolean(process.env.TEST_DATABASE_URL);

/** A controllable clock shared by the app and the fake Spotify. */
export class Clock {
  constructor(public now = Date.UTC(2026, 0, 1)) {}
  advance(ms: number) {
    this.now += ms;
  }
  fn = () => this.now;
}

export interface Persona {
  profile: SpotifyProfile;
  topArtists: SpotifyArtist[];
}

const TOKEN_TTL_MS = 3600 * 1000;

/** In-memory stand-in for Spotify that behaves like the real API: tokens expire and can be refreshed. */
export class FakeSpotify implements SpotifyClient {
  private personas = new Map<string, Persona>();
  private codes = new Map<string, string>();
  private access = new Map<string, { spotifyId: string; expiresAt: number }>();
  private refresh = new Map<string, string>();
  private counter = 0;
  calls = { exchange: 0, refresh: 0, topArtists: 0 };
  failTopArtists = false;

  constructor(private readonly clock: Clock) {}

  addPersona(p: Persona) {
    this.personas.set(p.profile.id, p);
  }

  setTopArtists(spotifyId: string, topArtists: SpotifyArtist[]) {
    this.personas.get(spotifyId)!.topArtists = topArtists;
  }

  /** A one-time authorization code for this Spotify user, as if they approved the consent screen. */
  issueCode(spotifyId: string): string {
    const code = `code-${spotifyId}-${++this.counter}`;
    this.codes.set(code, spotifyId);
    return code;
  }

  authorizeUrl(state: string): string {
    return `https://accounts.spotify.test/authorize?state=${encodeURIComponent(state)}`;
  }

  async exchangeCode(code: string) {
    this.calls.exchange++;
    const spotifyId = this.codes.get(code);
    if (!spotifyId) throw new HttpError(401, "spotify_auth_failed", "invalid_grant");
    this.codes.delete(code);
    const refreshToken = `refresh-${spotifyId}-${++this.counter}`;
    this.refresh.set(refreshToken, spotifyId);
    return { ...this.mintAccess(spotifyId), refreshToken };
  }

  async refreshAccessToken(refreshToken: string): Promise<SpotifyTokens> {
    this.calls.refresh++;
    const spotifyId = this.refresh.get(refreshToken);
    if (!spotifyId) throw new HttpError(401, "spotify_auth_failed", "invalid_grant");
    return this.mintAccess(spotifyId);
  }

  async getProfile(accessToken: string) {
    return this.persona(accessToken).profile;
  }

  async getTopArtists(accessToken: string) {
    this.calls.topArtists++;
    const p = this.persona(accessToken);
    if (this.failTopArtists) throw new HttpError(502, "spotify_error", "Spotify is down");
    return p.topArtists;
  }

  private mintAccess(spotifyId: string): SpotifyTokens {
    const accessToken = `access-${spotifyId}-${++this.counter}`;
    const expiresAt = this.clock.now + TOKEN_TTL_MS;
    this.access.set(accessToken, { spotifyId, expiresAt });
    return { accessToken, expiresAt: new Date(expiresAt) };
  }

  private persona(accessToken: string): Persona {
    const t = this.access.get(accessToken);
    if (!t || t.expiresAt <= this.clock.now) {
      throw new HttpError(401, "spotify_token_invalid", "Spotify access token rejected");
    }
    return this.personas.get(t.spotifyId)!;
  }
}

export function artist(id: string, genres: string[]): SpotifyArtist {
  return { id, name: id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), genres };
}

export function persona(id: string, name: string, topArtists: SpotifyArtist[]): Persona {
  return { profile: { id, displayName: name, email: `${id}@example.test`, avatarUrl: null }, topArtists };
}

export async function setup() {
  const clock = new Clock();
  const spotify = new FakeSpotify(clock);
  const db = await createTestDb();
  const logged: unknown[] = [];
  const app = createApp({ db, spotify, config: TEST_CONFIG, now: clock.fn, log: (...args) => logged.push(args) });
  return { app, db, spotify, clock, logged };
}

export type Harness = Awaited<ReturnType<typeof setup>>;

/** Runs the real OAuth flow (login redirect, state cookie, callback) for a fake Spotify user. */
export async function login(h: Harness, spotifyId: string) {
  const agent = request.agent(h.app);
  const start = await agent.get("/auth/spotify/login").expect(302);
  const state = new URL(start.headers.location!).searchParams.get("state")!;
  const code = h.spotify.issueCode(spotifyId);
  const res = await agent.get("/auth/spotify/callback").query({ code, state });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    token: res.body.token as string,
    userId: res.body.user.id as string,
    body: res.body,
    auth: { Authorization: `Bearer ${res.body.token}` },
  };
}
