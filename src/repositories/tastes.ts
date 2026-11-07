import type { Queryable } from "../db";
import type { Taste } from "../matching/similarity";
import type { TasteProfile } from "../spotify/taste";
import { placeholders, rowPlaceholders } from "./sql";

export interface StoredTaste extends Taste {
  artistNames: ReadonlyMap<string, string>;
}

/** Replaces the user's stored artists and genres. Run inside a transaction. */
export async function replaceTaste(q: Queryable, userId: string, profile: TasteProfile): Promise<void> {
  await q.query("DELETE FROM user_artists WHERE user_id = $1", [userId]);
  await q.query("DELETE FROM user_genres WHERE user_id = $1", [userId]);

  if (profile.artists.length > 0) {
    await q.query(
      `INSERT INTO user_artists (user_id, spotify_artist_id, name, rank, weight)
       VALUES ${rowPlaceholders(profile.artists.length, 5)}`,
      profile.artists.flatMap((a) => [userId, a.id, a.name, a.rank, a.weight]),
    );
  }
  if (profile.genres.length > 0) {
    await q.query(
      `INSERT INTO user_genres (user_id, genre, weight) VALUES ${rowPlaceholders(profile.genres.length, 3)}`,
      profile.genres.flatMap((g) => [userId, g.genre, g.weight]),
    );
  }
}

/** Loads taste vectors for several users at once. Users with no stored taste get empty vectors. */
export async function loadTastes(q: Queryable, userIds: string[]): Promise<Map<string, StoredTaste>> {
  const result = new Map<string, { artists: Map<string, number>; genres: Map<string, number>; artistNames: Map<string, string> }>();
  for (const id of userIds) result.set(id, { artists: new Map(), genres: new Map(), artistNames: new Map() });
  if (userIds.length === 0) return result;

  const inList = placeholders(userIds.length);
  const [artists, genres] = await Promise.all([
    q.query<{ user_id: string; spotify_artist_id: string; name: string; weight: number }>(
      `SELECT user_id, spotify_artist_id, name, weight FROM user_artists WHERE user_id IN (${inList})`,
      userIds,
    ),
    q.query<{ user_id: string; genre: string; weight: number }>(
      `SELECT user_id, genre, weight FROM user_genres WHERE user_id IN (${inList})`,
      userIds,
    ),
  ]);
  for (const r of artists.rows) {
    const t = result.get(r.user_id)!;
    t.artists.set(r.spotify_artist_id, Number(r.weight));
    t.artistNames.set(r.spotify_artist_id, r.name);
  }
  for (const r of genres.rows) result.get(r.user_id)!.genres.set(r.genre, Number(r.weight));
  return result;
}
