import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { placeholders } from "./sql";

interface UserRow {
  id: string;
  spotify_id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  bio: string;
  taste_synced_at: Date | null;
  created_at: Date;
}

export interface User {
  id: string;
  spotifyId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  bio: string;
  tasteSyncedAt: Date | null;
  createdAt: Date;
}

/** What other users get to see. */
export interface PublicProfile {
  id: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
}

export interface StoredSpotifyTokens {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
}

const USER_COLUMNS = "id, spotify_id, display_name, email, avatar_url, bio, taste_synced_at, created_at";

const toUser = (r: UserRow): User => ({
  id: r.id,
  spotifyId: r.spotify_id,
  displayName: r.display_name,
  email: r.email,
  avatarUrl: r.avatar_url,
  bio: r.bio,
  tasteSyncedAt: r.taste_synced_at ? new Date(r.taste_synced_at) : null,
  createdAt: new Date(r.created_at),
});

export const toPublicProfile = (u: Pick<User, "id" | "displayName" | "bio" | "avatarUrl">): PublicProfile => ({
  id: u.id,
  displayName: u.displayName,
  bio: u.bio,
  avatarUrl: u.avatarUrl,
});

/**
 * Creates the user on first login, or refreshes their Spotify details and tokens on later logins.
 * The display name is only set on creation so a name the user edited is not overwritten.
 * Tokens must already be encrypted.
 */
export async function upsertSpotifyUser(
  q: Queryable,
  input: {
    spotifyId: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    encryptedAccessToken: string;
    encryptedRefreshToken: string;
    tokenExpiresAt: Date;
  },
): Promise<User> {
  const { rows } = await q.query<UserRow>(
    `INSERT INTO users (id, spotify_id, display_name, email, avatar_url,
                        spotify_access_token, spotify_refresh_token, spotify_token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (spotify_id) DO UPDATE SET
       email = EXCLUDED.email,
       avatar_url = EXCLUDED.avatar_url,
       spotify_access_token = EXCLUDED.spotify_access_token,
       spotify_refresh_token = EXCLUDED.spotify_refresh_token,
       spotify_token_expires_at = EXCLUDED.spotify_token_expires_at,
       updated_at = now()
     RETURNING ${USER_COLUMNS}`,
    [
      randomUUID(),
      input.spotifyId,
      input.displayName,
      input.email,
      input.avatarUrl,
      input.encryptedAccessToken,
      input.encryptedRefreshToken,
      input.tokenExpiresAt,
    ],
  );
  return toUser(rows[0]!);
}

export async function findUserById(q: Queryable, id: string): Promise<User | null> {
  const { rows } = await q.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUsersByIds(q: Queryable, ids: string[]): Promise<Map<string, User>> {
  if (ids.length === 0) return new Map();
  const { rows } = await q.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id IN (${placeholders(ids.length)})`,
    ids,
  );
  return new Map(rows.map((r) => [r.id, toUser(r)]));
}

export async function updateProfile(
  q: Queryable,
  id: string,
  patch: { displayName?: string; bio?: string },
): Promise<User | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.displayName !== undefined) {
    params.push(patch.displayName);
    sets.push(`display_name = $${params.length}`);
  }
  if (patch.bio !== undefined) {
    params.push(patch.bio);
    sets.push(`bio = $${params.length}`);
  }
  if (sets.length === 0) return findUserById(q, id);
  const { rows } = await q.query<UserRow>(
    `UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    params,
  );
  return rows[0] ? toUser(rows[0]) : null;
}

export async function getSpotifyTokens(q: Queryable, id: string): Promise<StoredSpotifyTokens | null> {
  const { rows } = await q.query<{
    spotify_access_token: string | null;
    spotify_refresh_token: string | null;
    spotify_token_expires_at: Date | null;
  }>(
    "SELECT spotify_access_token, spotify_refresh_token, spotify_token_expires_at FROM users WHERE id = $1",
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    accessToken: r.spotify_access_token,
    refreshToken: r.spotify_refresh_token,
    expiresAt: r.spotify_token_expires_at ? new Date(r.spotify_token_expires_at) : null,
  };
}

export async function saveSpotifyTokens(
  q: Queryable,
  id: string,
  tokens: { encryptedAccessToken: string; encryptedRefreshToken: string; expiresAt: Date },
): Promise<void> {
  await q.query(
    `UPDATE users SET spotify_access_token = $2, spotify_refresh_token = $3,
       spotify_token_expires_at = $4, updated_at = now() WHERE id = $1`,
    [id, tokens.encryptedAccessToken, tokens.encryptedRefreshToken, tokens.expiresAt],
  );
}

export async function markTasteSynced(q: Queryable, id: string, at: Date): Promise<void> {
  await q.query("UPDATE users SET taste_synced_at = $2, updated_at = now() WHERE id = $1", [id, at]);
}

/**
 * Locks both users' rows (in a fixed order, so two concurrent likes can't deadlock) and returns
 * the ids that exist. Serializes the like/match check for a pair so a mutual like can't be missed.
 */
export async function lockUsers(q: Queryable, ids: string[]): Promise<Set<string>> {
  const sorted = [...new Set(ids)].sort();
  const { rows } = await q.query<{ id: string }>(
    `SELECT id FROM users WHERE id IN (${placeholders(sorted.length)}) ORDER BY id FOR UPDATE`,
    sorted,
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * People the user hasn't decided on yet who share at least one artist or genre with them.
 * The shared-interest filter keeps the candidate pool small; exact scoring happens in the app.
 */
export async function findCandidateIds(q: Queryable, userId: string, poolSize: number): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT u.id FROM users u
     LEFT JOIN likes l ON l.liker_id = $1 AND l.likee_id = u.id
     WHERE u.id <> $1
       AND u.taste_synced_at IS NOT NULL
       AND l.liker_id IS NULL
       AND u.id IN (
         SELECT g.user_id FROM user_genres g
           JOIN user_genres mine ON mine.genre = g.genre
           WHERE mine.user_id = $1
         UNION
         SELECT a.user_id FROM user_artists a
           JOIN user_artists mine ON mine.spotify_artist_id = a.spotify_artist_id
           WHERE mine.user_id = $1
       )
     ORDER BY u.taste_synced_at DESC
     LIMIT $2`,
    [userId, poolSize],
  );
  return rows.map((r) => r.id);
}
