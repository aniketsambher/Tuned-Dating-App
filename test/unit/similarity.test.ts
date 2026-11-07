import { describe, expect, it } from "vitest";
import { normalizeWeights, scoreMatch, sharedKeys, type Taste, weightedJaccard } from "../../src/matching/similarity";

const v = (entries: Record<string, number>) => new Map(Object.entries(entries));
const taste = (artists: Record<string, number>, genres: Record<string, number> = {}): Taste => ({
  artists: v(artists),
  genres: v(genres),
});

describe("weightedJaccard", () => {
  it("is 1 for identical vectors", () => {
    expect(weightedJaccard(v({ a: 1, b: 0.5 }), v({ a: 1, b: 0.5 }))).toBe(1);
  });

  it("is 0 when nothing is shared", () => {
    expect(weightedJaccard(v({ a: 1 }), v({ b: 1 }))).toBe(0);
  });

  it("is 0 (not NaN) when both vectors are empty", () => {
    expect(weightedJaccard(v({}), v({}))).toBe(0);
  });

  it("sums min over max across the union of keys", () => {
    // min: a=0.5, b=0, c=0 -> 0.5 ; max: a=1, b=0.5, c=1 -> 2.5
    expect(weightedJaccard(v({ a: 1, b: 0.5 }), v({ a: 0.5, c: 1 }))).toBeCloseTo(0.5 / 2.5);
  });

  it("is symmetric", () => {
    const a = v({ x: 0.9, y: 0.2, z: 0.4 });
    const b = v({ x: 0.3, z: 1, w: 0.7 });
    expect(weightedJaccard(a, b)).toBeCloseTo(weightedJaccard(b, a));
  });

  it("rewards sharing someone's top artists more than their long tail", () => {
    const me = v({ top: 1, tail: 0.1 });
    expect(weightedJaccard(me, v({ top: 1 }))).toBeGreaterThan(weightedJaccard(me, v({ tail: 0.1 })));
  });
});

describe("sharedKeys", () => {
  it("orders shared keys by the weaker of the two weights", () => {
    const a = v({ x: 1, y: 0.9, z: 0.2, only_a: 1 });
    const b = v({ x: 0.3, y: 0.8, z: 1, only_b: 1 });
    // min weights: x=0.3, y=0.8, z=0.2
    expect(sharedKeys(a, b)).toEqual(["y", "x", "z"]);
  });
});

describe("normalizeWeights", () => {
  it("scales weights to sum to 1", () => {
    expect(normalizeWeights({ artists: 3, genres: 1 })).toEqual({ artists: 0.75, genres: 0.25 });
  });

  it("rejects negative or all-zero weights", () => {
    expect(() => normalizeWeights({ artists: -1, genres: 1 })).toThrow();
    expect(() => normalizeWeights({ artists: 0, genres: 0 })).toThrow();
  });
});

describe("scoreMatch", () => {
  const weights = { artists: 0.6, genres: 0.4 };

  it("blends artist and genre similarity by the configured weights", () => {
    const a = taste({ x: 1 }, { indie: 1 });
    const b = taste({ y: 1 }, { indie: 1 }); // no shared artists, identical genres
    const s = scoreMatch(a, b, weights);
    expect(s.artistScore).toBe(0);
    expect(s.genreScore).toBe(1);
    expect(s.score).toBeCloseTo(0.4);
  });

  it("scores a perfect match as 1", () => {
    const a = taste({ x: 1, y: 0.5 }, { indie: 1, pop: 0.5 });
    expect(scoreMatch(a, a, weights).score).toBeCloseTo(1);
  });

  it("drops the genre term when either user has no genre data", () => {
    const a = taste({ x: 1, y: 0.5 }, { indie: 1 });
    const b = taste({ x: 1, y: 0.5 }); // Spotify returned no genres for b
    const s = scoreMatch(a, b, weights);
    expect(s.artistScore).toBe(1);
    expect(s.score).toBe(1); // not 0.6
  });

  it("lists shared artists and genres strongest first", () => {
    const a = taste({ x: 1, y: 0.5 }, { indie: 1, rock: 0.2 });
    const b = taste({ x: 0.4, y: 0.9 }, { indie: 0.5, rock: 1 });
    const s = scoreMatch(a, b, weights);
    expect(s.sharedArtists).toEqual(["y", "x"]);
    expect(s.sharedGenres).toEqual(["indie", "rock"]);
  });

  it("ranks a closer taste above a looser one", () => {
    const me = taste({ a: 1, b: 0.8, c: 0.6 }, { indie: 1, folk: 0.7 });
    const close = taste({ a: 0.9, b: 1, d: 0.5 }, { indie: 1, folk: 0.5 });
    const loose = taste({ c: 1, e: 0.9, f: 0.8 }, { indie: 0.3, metal: 1 });
    expect(scoreMatch(me, close, weights).score).toBeGreaterThan(scoreMatch(me, loose, weights).score);
  });
});
