import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { everyone } from "./fixtures";
import { type Harness, login, setup } from "./helpers";

let h: Harness;
type Session = Awaited<ReturnType<typeof login>>;
let alice: Session, bob: Session, carol: Session, dave: Session;

beforeEach(async () => {
  h = await setup();
  everyone.forEach((p) => h.spotify.addPersona(structuredClone(p)));
  alice = await login(h, "alice");
  bob = await login(h, "bob");
  carol = await login(h, "carol");
  dave = await login(h, "dave");
});

afterEach(async () => {
  await h.db.end();
});

const discover = async (s: Session) => (await request(h.app).get("/discover").set(s.auth).expect(200)).body.candidates;
const like = (s: Session, userId: string) => request(h.app).post("/likes").set(s.auth).send({ userId });
const pass = (s: Session, userId: string) => request(h.app).post("/passes").set(s.auth).send({ userId });
const matches = async (s: Session) => (await request(h.app).get("/matches").set(s.auth).expect(200)).body.matches;

describe("GET /discover", () => {
  it("ranks people by music compatibility and leaves out people with nothing in common", async () => {
    const candidates = await discover(alice);
    expect(candidates.map((c: { user: { displayName: string } }) => c.user.displayName)).toEqual(["Bob", "Carol"]);

    const [first, second] = candidates;
    expect(first.compatibility.score).toBeGreaterThan(second.compatibility.score);
    expect(first.compatibility.sharedArtists.map((a: { name: string }) => a.name)).toEqual(
      expect.arrayContaining(["Phoebe Bridgers", "Big Thief", "Mitski"]),
    );
    expect(second.compatibility.sharedArtists).toEqual([{ id: "mitski", name: "Mitski" }]);
    expect(second.compatibility.sharedGenres).toContain("art pop");
  });

  it("only exposes public profile fields", async () => {
    const [first] = await discover(alice);
    expect(Object.keys(first.user).sort()).toEqual(["avatarUrl", "bio", "displayName", "id"]);
  });

  it("scores symmetrically: Alice sees Bob at the same score Bob sees Alice", async () => {
    const aliceSeesBob = (await discover(alice)).find((c: { user: { id: string } }) => c.user.id === bob.userId);
    const bobSeesAlice = (await discover(bob)).find((c: { user: { id: string } }) => c.user.id === alice.userId);
    expect(aliceSeesBob.compatibility.score).toBe(bobSeesAlice.compatibility.score);
  });

  it("returns no one for a user whose taste overlaps with nobody", async () => {
    expect(await discover(dave)).toEqual([]);
  });

  it("respects the limit and validates it", async () => {
    const res = await request(h.app).get("/discover").query({ limit: 1 }).set(alice.auth).expect(200);
    expect(res.body.candidates).toHaveLength(1);
    await request(h.app).get("/discover").query({ limit: 0 }).set(alice.auth).expect(400);
    await request(h.app).get("/discover").query({ limit: "lots" }).set(alice.auth).expect(400);
  });

  it("asks the user to sync first if their taste was never pulled", async () => {
    h.spotify.addPersona({
      profile: { id: "erin", displayName: "Erin", email: null, avatarUrl: null },
      topArtists: [],
    });
    h.spotify.failTopArtists = true;
    const erin = await login(h, "erin");
    const res = await request(h.app).get("/discover").set(erin.auth).expect(409);
    expect(res.body.error.code).toBe("taste_not_synced");
  });

  it("hides people you've already liked or passed on", async () => {
    await like(alice, bob.userId).expect(200);
    await pass(alice, carol.userId).expect(204);
    expect(await discover(alice)).toEqual([]);
  });
});

describe("likes and matches", () => {
  it("a one-sided like is recorded but is not a match", async () => {
    const res = await like(alice, bob.userId).expect(200);
    expect(res.body).toEqual({ matched: false, match: null });
    expect(await matches(alice)).toEqual([]);
    expect(await matches(bob)).toEqual([]);
  });

  it("a mutual like creates a match that both people see", async () => {
    await like(alice, bob.userId).expect(200);
    const res = await like(bob, alice.userId).expect(201);

    expect(res.body.matched).toBe(true);
    expect(res.body.match.user).toMatchObject({ id: alice.userId, displayName: "Alice" });
    expect(res.body.match.compatibility.score).toBeGreaterThan(0.5);

    const [aliceMatch] = await matches(alice);
    const [bobMatch] = await matches(bob);
    expect(aliceMatch.id).toBe(bobMatch.id);
    expect(aliceMatch.user.id).toBe(bob.userId);
    expect(bobMatch.user.id).toBe(alice.userId);
    expect(aliceMatch.compatibility.score).toBe(res.body.match.compatibility.score);
    expect(aliceMatch.compatibility.sharedArtists.length).toBeGreaterThan(0);
  });

  it("stores the match score from the weighted similarity, matching what discover showed", async () => {
    const shown = (await discover(alice)).find((c: { user: { id: string } }) => c.user.id === carol.userId);
    await like(alice, carol.userId);
    const res = await like(carol, alice.userId).expect(201);
    expect(res.body.match.compatibility.score).toBe(shown.compatibility.score);
  });

  it("liking again after matching is idempotent", async () => {
    await like(alice, bob.userId);
    const first = await like(bob, alice.userId).expect(201);
    const again = await like(alice, bob.userId).expect(201);
    expect(again.body.match.id).toBe(first.body.match.id);
    expect(await matches(alice)).toHaveLength(1);

    const { rows } = await h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM matches");
    expect(rows[0]!.n).toBe(1);
  });

  it("two people liking each other at the same moment get exactly one match", async () => {
    const [a, b] = await Promise.all([like(alice, bob.userId), like(bob, alice.userId)]);
    expect([a.body.matched, b.body.matched]).toContain(true);
    const { rows } = await h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM matches");
    expect(rows[0]!.n).toBe(1);
  });

  it("a pass followed by a change of heart can still become a match", async () => {
    await pass(alice, bob.userId).expect(204);
    await like(bob, alice.userId).expect(200);
    const res = await like(alice, bob.userId).expect(201);
    expect(res.body.matched).toBe(true);
  });

  it("a like from someone you passed on does not create a match", async () => {
    await pass(alice, bob.userId).expect(204);
    const res = await like(bob, alice.userId).expect(200);
    expect(res.body.matched).toBe(false);
  });

  it("can't pass on someone you've already matched with", async () => {
    await like(alice, bob.userId);
    await like(bob, alice.userId).expect(201);
    const res = await pass(alice, bob.userId).expect(409);
    expect(res.body.error.code).toBe("already_matched");
  });

  it("lists matches newest first", async () => {
    await like(bob, alice.userId);
    await like(alice, bob.userId).expect(201);
    h.clock.advance(1000);
    await new Promise((r) => setTimeout(r, 5)); // created_at comes from the database clock
    await like(carol, alice.userId);
    await like(alice, carol.userId).expect(201);

    const list = await matches(alice);
    expect(list.map((m: { user: { displayName: string } }) => m.user.displayName)).toEqual(["Carol", "Bob"]);
  });

  it("rejects liking yourself, unknown users, and malformed ids", async () => {
    expect((await like(alice, alice.userId).expect(400)).body.error.code).toBe("cannot_like_self");
    expect((await like(alice, randomUUID()).expect(404)).body.error.code).toBe("not_found");
    expect((await like(alice, "not-a-uuid").expect(400)).body.error.code).toBe("invalid_request");
    await request(h.app).post("/likes").set(alice.auth).set("Content-Type", "application/json").send("{bad json").expect(400);
  });

  it("accepts an upper-case UUID", async () => {
    await like(bob, alice.userId);
    const res = await like(alice, bob.userId.toUpperCase()).expect(201);
    expect(res.body.matched).toBe(true);
  });

  it("requires authentication", async () => {
    await request(h.app).post("/likes").send({ userId: bob.userId }).expect(401);
    await request(h.app).get("/matches").expect(401);
    await request(h.app).get("/discover").expect(401);
  });
});
