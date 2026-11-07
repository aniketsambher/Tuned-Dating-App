import { z } from "zod";
import { HttpError } from "../errors";

export const SPOTIFY_SCOPES = ["user-top-read", "user-read-email"];
const ACCOUNTS_URL = "https://accounts.spotify.com";
const API_URL = "https://api.spotify.com/v1";

export type TimeRange = "short_term" | "medium_term" | "long_term";

export interface SpotifyTokens {
  accessToken: string;
  /** Spotify only sometimes returns a new refresh token on refresh; keep the old one when absent. */
  refreshToken?: string;
  expiresAt: Date;
}

export interface SpotifyProfile {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
}

export interface SpotifyClient {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<SpotifyTokens & { refreshToken: string }>;
  refreshAccessToken(refreshToken: string): Promise<SpotifyTokens>;
  getProfile(accessToken: string): Promise<SpotifyProfile>;
  getTopArtists(accessToken: string, opts?: { limit?: number; timeRange?: TimeRange }): Promise<SpotifyArtist[]>;
}

const tokenResponse = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

const profileResponse = z.object({
  id: z.string(),
  display_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  images: z.array(z.object({ url: z.string() })).nullable().optional(),
});

const topArtistsResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      // Some Spotify app tiers return artists without genres, so treat the field as optional.
      genres: z.array(z.string()).optional(),
    }),
  ),
});

type FetchFn = typeof fetch;

export class HttpSpotifyClient implements SpotifyClient {
  constructor(
    private readonly opts: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.opts.clientId,
      scope: SPOTIFY_SCOPES.join(" "),
      redirect_uri: this.opts.redirectUri,
      state,
    });
    return `${ACCOUNTS_URL}/authorize?${params}`;
  }

  async exchangeCode(code: string) {
    const tokens = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.opts.redirectUri,
    });
    if (!tokens.refreshToken) throw new HttpError(502, "spotify_error", "Spotify did not return a refresh token");
    return { ...tokens, refreshToken: tokens.refreshToken };
  }

  refreshAccessToken(refreshToken: string) {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async getProfile(accessToken: string): Promise<SpotifyProfile> {
    const body = profileResponse.parse(await this.apiGet("/me", accessToken));
    return {
      id: body.id,
      displayName: body.display_name?.trim() || body.id,
      email: body.email ?? null,
      avatarUrl: body.images?.[0]?.url ?? null,
    };
  }

  async getTopArtists(accessToken: string, opts: { limit?: number; timeRange?: TimeRange } = {}) {
    const params = new URLSearchParams({
      limit: String(opts.limit ?? 50),
      time_range: opts.timeRange ?? "medium_term",
    });
    const body = topArtistsResponse.parse(await this.apiGet(`/me/top/artists?${params}`, accessToken));
    return body.items.map((a) => ({ id: a.id, name: a.name, genres: a.genres ?? [] }));
  }

  private async tokenRequest(form: Record<string, string>): Promise<SpotifyTokens> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.fetchFn(`${ACCOUNTS_URL}/api/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    if (!res.ok) {
      // 400 invalid_grant means the code or refresh token is bad or revoked: the user must log in again.
      const status = res.status === 400 ? 401 : 502;
      throw new HttpError(status, "spotify_auth_failed", `Spotify token request failed (${res.status})`);
    }
    const body = tokenResponse.parse(await res.json());
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(this.now() + body.expires_in * 1000),
    };
  }

  private async apiGet(path: string, accessToken: string, attempt = 0): Promise<unknown> {
    const res = await this.fetchFn(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 429 && attempt === 0) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      if (Number.isFinite(retryAfter) && retryAfter <= 5) {
        await this.sleep(retryAfter * 1000);
        return this.apiGet(path, accessToken, attempt + 1);
      }
    }
    if (res.status === 401) throw new HttpError(401, "spotify_token_invalid", "Spotify access token rejected");
    if (!res.ok) {
      const endpoint = path.split("?")[0];
      const detail = await spotifyErrorMessage(res);
      const suffix = detail ? `: ${detail.replace(/[.\s]+$/, "")}` : "";
      if (res.status === 403) {
        // In development mode, Spotify answers 403 for accounts the app isn't allowed to serve.
        throw new HttpError(
          403,
          "spotify_forbidden",
          `Spotify refused ${endpoint} (403)${suffix}. If the app is in development mode, make sure this ` +
            "Spotify account is listed under User Management in the Spotify developer dashboard.",
        );
      }
      throw new HttpError(502, "spotify_error", `Spotify API ${endpoint} failed (${res.status})${suffix}`);
    }
    return res.json();
  }
}

/** Spotify's own explanation from an error response, if it sent one. Never throws. */
async function spotifyErrorMessage(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    if (!text) return "";
    try {
      const body = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string };
      const message =
        typeof body.error === "object" ? body.error?.message : (body.error_description ?? body.error);
      if (message) return String(message).slice(0, 300);
    } catch {
      // Not JSON: fall through to the raw text.
    }
    return text.slice(0, 300);
  } catch {
    return "";
  }
}
