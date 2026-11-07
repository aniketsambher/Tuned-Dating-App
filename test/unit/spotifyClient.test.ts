import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../src/errors";
import { HttpSpotifyClient } from "../../src/spotify/client";

const opts = { clientId: "cid", clientSecret: "csecret", redirectUri: "http://127.0.0.1:3000/auth/spotify/callback" };
const NOW = 1_700_000_000_000;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function clientWith(...responses: Response[]) {
  const fetchFn = vi.fn<typeof fetch>();
  for (const r of responses) fetchFn.mockResolvedValueOnce(r);
  const sleep = vi.fn(async () => {});
  return { client: new HttpSpotifyClient(opts, fetchFn, () => NOW, sleep), fetchFn, sleep };
}

describe("HttpSpotifyClient", () => {
  it("builds the authorize URL with scopes, redirect URI and state", () => {
    const url = new URL(clientWith().client.authorizeUrl("abc123"));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(opts.redirectUri);
    expect(url.searchParams.get("state")).toBe("abc123");
    expect(url.searchParams.get("scope")).toContain("user-top-read");
  });

  it("exchanges a code using client credentials in a Basic header", async () => {
    const { client, fetchFn } = clientWith(
      jsonResponse({ access_token: "at", token_type: "Bearer", expires_in: 3600, refresh_token: "rt" }),
    );
    const tokens = await client.exchangeCode("the-code");

    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: new Date(NOW + 3_600_000) });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://accounts.spotify.com/api/token");
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("cid:csecret").toString("base64")}`,
    );
    const body = new URLSearchParams(init!.body as URLSearchParams);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("redirect_uri")).toBe(opts.redirectUri);
  });

  it("maps a rejected code (400 invalid_grant) to 401 so the user logs in again", async () => {
    const { client } = clientWith(jsonResponse({ error: "invalid_grant" }, 400));
    await expect(client.exchangeCode("bad")).rejects.toMatchObject({ status: 401, code: "spotify_auth_failed" });
  });

  it("allows a refresh response without a new refresh token", async () => {
    const { client } = clientWith(jsonResponse({ access_token: "at2", token_type: "Bearer", expires_in: 3600 }));
    const tokens = await client.refreshAccessToken("rt");
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBeUndefined();
  });

  it("fetches top artists and tolerates missing genres", async () => {
    const { client, fetchFn } = clientWith(
      jsonResponse({
        items: [
          { id: "1", name: "Mitski", genres: ["indie pop"], popularity: 80 },
          { id: "2", name: "Unknown" },
        ],
      }),
    );
    const artists = await client.getTopArtists("at", { limit: 10, timeRange: "short_term" });

    expect(artists).toEqual([
      { id: "1", name: "Mitski", genres: ["indie pop"] },
      { id: "2", name: "Unknown", genres: [] },
    ]);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.spotify.com/v1/me/top/artists?limit=10&time_range=short_term");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer at");
  });

  it("falls back to the Spotify id when the profile has no display name", async () => {
    const { client } = clientWith(jsonResponse({ id: "spotify-user", display_name: null, images: [] }));
    expect(await client.getProfile("at")).toEqual({
      id: "spotify-user",
      displayName: "spotify-user",
      email: null,
      avatarUrl: null,
    });
  });

  it("retries once after a short 429", async () => {
    const { client, fetchFn, sleep } = clientWith(
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
      jsonResponse({ items: [] }),
    );
    expect(await client.getTopArtists("at")).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("surfaces Spotify's own message when it refuses a request with 403", async () => {
    const { client } = clientWith(
      jsonResponse({ error: { status: 403, message: "User not registered in the Developer Dashboard" } }, 403),
    );
    const err = await client.getProfile("at").catch((e) => e);
    expect(err).toMatchObject({ status: 403, code: "spotify_forbidden" });
    expect(err.message).toContain("User not registered in the Developer Dashboard");
    expect(err.message).toContain("User Management");
  });

  it("includes non-JSON error text from Spotify", async () => {
    const { client } = clientWith(new Response("upstream timeout", { status: 503 }));
    const err = await client.getTopArtists("at").catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: "spotify_error" });
    expect(err.message).toBe("Spotify API /me/top/artists failed (503): upstream timeout");
  });

  it("reports an expired access token distinctly so the caller can refresh", async () => {
    const { client } = clientWith(new Response("", { status: 401 }));
    const err = await client.getTopArtists("at").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 401, code: "spotify_token_invalid" });
  });
});
