import type { TokenCipher } from "../crypto";
import type { Queryable } from "../db";
import { conflict, notFound } from "../errors";
import { getSpotifyTokens, saveSpotifyTokens } from "../repositories/users";
import type { SpotifyClient, SpotifyTokens } from "../spotify/client";

/** Refresh a little before expiry so a token doesn't die mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

/** Keeps each user's Spotify tokens encrypted in the database and refreshes them when needed. */
export class SpotifyTokenService {
  constructor(
    private readonly db: Queryable,
    private readonly spotify: SpotifyClient,
    private readonly cipher: TokenCipher,
    private readonly now: () => number = Date.now,
  ) {}

  encrypt(tokens: SpotifyTokens & { refreshToken: string }) {
    return {
      encryptedAccessToken: this.cipher.encrypt(tokens.accessToken),
      encryptedRefreshToken: this.cipher.encrypt(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
    };
  }

  /** A usable access token for the user, refreshing (and persisting) it if it has expired. */
  async getAccessToken(userId: string, { forceRefresh = false } = {}): Promise<string> {
    const stored = await getSpotifyTokens(this.db, userId);
    if (!stored) throw notFound("User not found");
    if (!stored.refreshToken) throw conflict("spotify_not_connected", "Spotify account is not connected");

    const fresh = stored.accessToken && stored.expiresAt && stored.expiresAt.getTime() - EXPIRY_MARGIN_MS > this.now();
    if (fresh && !forceRefresh) return this.cipher.decrypt(stored.accessToken!);

    const refreshToken = this.cipher.decrypt(stored.refreshToken);
    const refreshed = await this.spotify.refreshAccessToken(refreshToken);
    await saveSpotifyTokens(
      this.db,
      userId,
      this.encrypt({ ...refreshed, refreshToken: refreshed.refreshToken ?? refreshToken }),
    );
    return refreshed.accessToken;
  }
}
