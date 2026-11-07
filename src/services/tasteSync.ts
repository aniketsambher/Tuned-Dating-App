import { type Database, withTransaction } from "../db";
import { HttpError } from "../errors";
import { replaceTaste } from "../repositories/tastes";
import { markTasteSynced } from "../repositories/users";
import type { SpotifyClient } from "../spotify/client";
import { buildTasteProfile } from "../spotify/taste";
import type { SpotifyTokenService } from "./spotifyTokens";

export interface SyncResult {
  artistCount: number;
  genreCount: number;
  syncedAt: Date;
}

/** Pulls a user's top artists from Spotify and stores them as weighted artist and genre vectors. */
export class TasteSyncService {
  constructor(
    private readonly db: Database,
    private readonly spotify: SpotifyClient,
    private readonly tokens: SpotifyTokenService,
    private readonly now: () => number = Date.now,
  ) {}

  /** Sync using the user's stored tokens. Retries once with a forced refresh if Spotify rejects the token. */
  async sync(userId: string): Promise<SyncResult> {
    const token = await this.tokens.getAccessToken(userId);
    try {
      return await this.syncWithAccessToken(userId, token);
    } catch (err) {
      if (!(err instanceof HttpError && err.code === "spotify_token_invalid")) throw err;
      const refreshed = await this.tokens.getAccessToken(userId, { forceRefresh: true });
      return this.syncWithAccessToken(userId, refreshed);
    }
  }

  async syncWithAccessToken(userId: string, accessToken: string): Promise<SyncResult> {
    const topArtists = await this.spotify.getTopArtists(accessToken, { limit: 50, timeRange: "medium_term" });
    const profile = buildTasteProfile(topArtists);
    const syncedAt = new Date(this.now());
    await withTransaction(this.db, async (tx) => {
      await replaceTaste(tx, userId, profile);
      await markTasteSynced(tx, userId, syncedAt);
    });
    return { artistCount: profile.artists.length, genreCount: profile.genres.length, syncedAt };
  }
}
