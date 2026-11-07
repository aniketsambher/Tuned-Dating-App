import { signSession } from "../auth/jwt";
import type { Queryable } from "../db";
import { upsertSpotifyUser, type User } from "../repositories/users";
import type { SpotifyClient } from "../spotify/client";
import type { SpotifyTokenService } from "./spotifyTokens";
import type { TasteSyncService } from "./tasteSync";

export interface LoginResult {
  token: string;
  user: User;
  /** False if login worked but pulling top artists failed; the client can retry with POST /me/sync. */
  tasteSynced: boolean;
}

export class AuthService {
  constructor(
    private readonly db: Queryable,
    private readonly spotify: SpotifyClient,
    private readonly tokens: SpotifyTokenService,
    private readonly tasteSync: TasteSyncService,
    private readonly jwtSecret: string,
    private readonly log: (msg: string, err?: unknown) => void = console.error,
  ) {}

  loginUrl(state: string): string {
    return this.spotify.authorizeUrl(state);
  }

  /** Finishes the OAuth code flow: stores the user and their tokens, syncs taste, issues a session. */
  async completeLogin(code: string): Promise<LoginResult> {
    const tokens = await this.spotify.exchangeCode(code);
    const profile = await this.spotify.getProfile(tokens.accessToken);
    const enc = this.tokens.encrypt(tokens);

    let user = await upsertSpotifyUser(this.db, {
      spotifyId: profile.id,
      displayName: profile.displayName,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      encryptedAccessToken: enc.encryptedAccessToken,
      encryptedRefreshToken: enc.encryptedRefreshToken,
      tokenExpiresAt: enc.expiresAt,
    });

    let tasteSynced = false;
    try {
      const result = await this.tasteSync.syncWithAccessToken(user.id, tokens.accessToken);
      user = { ...user, tasteSyncedAt: result.syncedAt };
      tasteSynced = true;
    } catch (err) {
      this.log(`taste sync failed during login for user ${user.id}`, err);
    }

    return { token: signSession(this.jwtSecret, user.id), user, tasteSynced };
  }
}
