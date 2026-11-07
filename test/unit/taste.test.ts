import { describe, expect, it } from "vitest";
import { buildTasteProfile, rankWeight } from "../../src/spotify/taste";

describe("rankWeight", () => {
  it("decays linearly from 1 for the top artist to 1/N for the last", () => {
    expect(rankWeight(0, 4)).toBe(1);
    expect(rankWeight(1, 4)).toBe(0.75);
    expect(rankWeight(3, 4)).toBe(0.25);
  });

  it("is 0 for out-of-range input", () => {
    expect(rankWeight(0, 0)).toBe(0);
    expect(rankWeight(4, 4)).toBe(0);
    expect(rankWeight(-1, 4)).toBe(0);
  });
});

describe("buildTasteProfile", () => {
  it("weights artists by rank", () => {
    const p = buildTasteProfile([
      { id: "a", name: "A", genres: [] },
      { id: "b", name: "B", genres: [] },
    ]);
    expect(p.artists).toEqual([
      { id: "a", name: "A", rank: 0, weight: 1 },
      { id: "b", name: "B", rank: 1, weight: 0.5 },
    ]);
  });

  it("drops duplicate artists, keeping the first (higher) rank", () => {
    const p = buildTasteProfile([
      { id: "a", name: "A", genres: [] },
      { id: "b", name: "B", genres: [] },
      { id: "a", name: "A", genres: [] },
    ]);
    expect(p.artists.map((a) => a.id)).toEqual(["a", "b"]);
    expect(p.artists[1]!.weight).toBe(0.5);
  });

  it("sums artist weights per genre and scales the strongest genre to 1", () => {
    // weights: a=1, b=2/3, c=1/3
    const p = buildTasteProfile([
      { id: "a", name: "A", genres: ["indie"] },
      { id: "b", name: "B", genres: ["indie", "folk"] },
      { id: "c", name: "C", genres: ["folk"] },
    ]);
    const g = Object.fromEntries(p.genres.map((x) => [x.genre, x.weight]));
    expect(g.indie).toBeCloseTo(1); // 1 + 2/3, the max
    expect(g.folk).toBeCloseTo(1 / (5 / 3)); // (2/3 + 1/3) / (5/3)
    expect(p.genres[0]!.genre).toBe("indie");
  });

  it("normalizes genre names and ignores blanks and repeats on one artist", () => {
    const p = buildTasteProfile([{ id: "a", name: "A", genres: [" Indie Pop ", "indie pop", ""] }]);
    expect(p.genres).toEqual([{ genre: "indie pop", weight: 1 }]);
  });

  it("handles an empty listening history", () => {
    expect(buildTasteProfile([])).toEqual({ artists: [], genres: [] });
  });
});
