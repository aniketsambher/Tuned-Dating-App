import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { alice, everyone } from "./fixtures";
import { type Harness, login, setup, TEST_CONFIG } from "./helpers";

let h: Harness;

beforeEach(async () => {
  h = await setup();
  everyone.forEach((p) => h.spotify.addPersona(structuredClone(p)));
});

afterEach(async () => {
  await h.db.end();
});

describe("Spotify OAuth login", () => {
  it("redirects to Spotify with a state value that is also set as an httpOnly cookie", async () => {
    const res = await request(h.app).get("/auth/spotify/login").expect(302);
    const state = new URL(res.headers.location!).searchParams.get("state");
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    const cookie = [res.headers["set-cookie"]].flat().join(";");
    expect(cookie).toContain(`tuned_oauth_state=${state}`);
    expect(cookie).toContain("HttpOnly");
  });

  it("rejects a callback whose state doesn't match the cookie (CSRF)", async () => {
    const agent = request.agent(h.app);
    await agent.get("/auth/spotify/login").expect(302);
    const res = await agent
      .get("/auth/spotify/callback")
      .query({ code: h.spotify.issueCode("alice"), state: "attacker-state" })
      .expect(400);
    expect(res.body.error.code).toBe("invalid_state");
    expect(h.spotify.calls.exchange).toBe(0);
  });

  it("rejects a callback with no state cookie at all", async () => {
    const res = await request(h.app)
      .get("/auth/spotify/callback")
      .query({ code: h.spotify.issueCode("alice"), state: "x" })
      .expect(400);
    expect(res.body.error.code).toBe("invalid_state");
  });

  it("reports when the user declines on Spotify's consent screen", async () => {
    const res = await request(h.app).get("/auth/spotify/callback").query({ error: "access_denied", state: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("spotify_denied");
  });

  it("creates the user, stores their top artists and genres, and returns a session token", async () => {
    const { body, auth } = await login(h, "alice");
    expect(body.tasteSynced).toBe(true);
    expect(body.user).toMatchObject({ spotifyId: "alice", displayName: "Alice", email: "alice@example.test" });

    const me = await request(h.app).get("/me").set(auth).expect(200);
    expect(me.body.taste.topArtists[0]).toEqual({ id: "phoebe-bridgers", name: "Phoebe Bridgers" });
    expect(me.body.taste.topGenres.slice(0, 2)).toEqual(["indie folk", "indie pop"]);
  });

  it("stores Spotify tokens encrypted, never in plaintext", async () => {
    const { userId } = await login(h, "alice");
    const { rows } = await h.db.query<{ spotify_access_token: string; spotify_refresh_token: string }>(
      "SELECT spotify_access_token, spotify_refresh_token FROM users WHERE id = $1",
      [userId],
    );
    expect(rows[0]!.spotify_access_token).toMatch(/^v1\./);
    expect(rows[0]!.spotify_access_token).not.toContain("access-alice");
    expect(rows[0]!.spotify_refresh_token).not.toContain("refresh-alice");
  });

  it("returns the same user on a second login and keeps a display name they edited", async () => {
    const first = await login(h, "alice");
    await request(h.app).patch("/me").set(first.auth).send({ displayName: "Ali" }).expect(200);

    const second = await login(h, "alice");
    expect(second.userId).toBe(first.userId);
    expect(second.body.user.displayName).toBe("Ali");
  });

  it("still logs the user in if pulling top artists fails, and they can retry the sync", async () => {
    h.spotify.failTopArtists = true;
    const { body, auth } = await login(h, "alice");
    expect(body.tasteSynced).toBe(false);
    expect(body.user.tasteSyncedAt).toBeNull();

    h.spotify.failTopArtists = false;
    const sync = await request(h.app).post("/me/sync").set(auth).expect(200);
    expect(sync.body).toMatchObject({ artistCount: 5, genreCount: 3 });
  });

  it("redirects to the app with the token in the URL fragment when APP_REDIRECT_URL is set", async () => {
    const app = createApp({
      db: h.db,
      spotify: h.spotify,
      config: { ...TEST_CONFIG, appRedirectUrl: "https://app.tuned.test/callback" },
      now: h.clock.fn,
      log: () => {},
    });
    const agent = request.agent(app);
    const start = await agent.get("/auth/spotify/login");
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    const res = await agent
      .get("/auth/spotify/callback")
      .query({ code: h.spotify.issueCode("alice"), state })
      .expect(302);
    const location = new URL(res.headers.location!);
    expect(location.origin + location.pathname).toBe("https://app.tuned.test/callback");
    expect(location.search).toBe("");
    expect(new URLSearchParams(location.hash.slice(1)).get("token")).toBeTruthy();
  });

  it("sends login failures back to the app (not a JSON page) when APP_REDIRECT_URL is set", async () => {
    const app = createApp({
      db: h.db,
      spotify: h.spotify,
      config: { ...TEST_CONFIG, appRedirectUrl: "https://app.tuned.test/" },
      now: h.clock.fn,
      log: () => {},
    });
    const agent = request.agent(app);
    await agent.get("/auth/spotify/login");
    const res = await agent
      .get("/auth/spotify/callback")
      .query({ code: h.spotify.issueCode("alice"), state: "wrong-state" })
      .expect(302);
    const fragment = new URLSearchParams(new URL(res.headers.location!).hash.slice(1));
    expect(fragment.get("error")).toBe("invalid_state");
    expect(fragment.get("message")).toBe("OAuth state did not match");
    expect(fragment.get("token")).toBeNull();
  });
});

describe("taste sync", () => {
  it("refreshes an expired Spotify access token before syncing", async () => {
    const { auth } = await login(h, "alice");
    h.clock.advance(2 * 3600 * 1000); // access token (1h) is now expired

    await request(h.app).post("/me/sync").set(auth).expect(200);
    expect(h.spotify.calls.refresh).toBe(1);

    // The refreshed token was saved, so a second sync doesn't refresh again.
    await request(h.app).post("/me/sync").set(auth).expect(200);
    expect(h.spotify.calls.refresh).toBe(1);
  });

  it("replaces the stored taste with the latest top artists", async () => {
    const { auth } = await login(h, "alice");
    h.spotify.setTopArtists("alice", [{ id: "miles-davis", name: "Miles Davis", genres: ["jazz"] }]);
    await request(h.app).post("/me/sync").set(auth).expect(200);

    const me = await request(h.app).get("/me").set(auth).expect(200);
    expect(me.body.taste).toEqual({ topArtists: [{ id: "miles-davis", name: "Miles Davis" }], topGenres: ["jazz"] });
  });
});

describe("profile", () => {
  it("requires a valid session", async () => {
    await request(h.app).get("/me").expect(401);
    await request(h.app).get("/me").set("Authorization", "Bearer not-a-jwt").expect(401);
  });

  it("updates display name and bio", async () => {
    const { auth } = await login(h, "alice");
    const res = await request(h.app)
      .patch("/me")
      .set(auth)
      .send({ displayName: "  Alice B  ", bio: "concerts > clubs" })
      .expect(200);
    expect(res.body.user).toMatchObject({ displayName: "Alice B", bio: "concerts > clubs" });
  });

  it("validates profile edits", async () => {
    const { auth } = await login(h, "alice");
    const res = await request(h.app).patch("/me").set(auth).send({ displayName: "", isAdmin: true }).expect(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("answers health checks", async () => {
    await request(h.app).get("/health").expect(200, { status: "ok" });
  });

  it("serves the web UI at / with a content security policy", async () => {
    const res = await request(h.app).get("/").expect(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("<title>Tuned</title>");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    await request(h.app).get("/app.js").expect(200).expect("content-type", /javascript/);
  });

  it("returns 404, not 401, for unknown routes", async () => {
    const res = await request(h.app).get("/nope").expect(404);
    expect(res.body.error.code).toBe("not_found");
  });
});
