export type WeightVector = ReadonlyMap<string, number>;

export interface Taste {
  artists: WeightVector;
  genres: WeightVector;
}

export interface MatchWeights {
  artists: number;
  genres: number;
}

export interface MatchScore {
  /** Combined score in [0, 1]. */
  score: number;
  artistScore: number;
  genreScore: number;
  /** Keys present in both vectors, strongest shared interest first. */
  sharedArtists: string[];
  sharedGenres: string[];
}

/**
 * Weighted Jaccard similarity: sum(min(a_i, b_i)) / sum(max(a_i, b_i)) over the union of keys.
 * 1 for identical vectors, 0 when nothing is shared (or both are empty).
 */
export function weightedJaccard(a: WeightVector, b: WeightVector): number {
  let minSum = 0;
  let maxSum = 0;
  for (const [key, wa] of a) {
    const wb = b.get(key) ?? 0;
    minSum += Math.min(wa, wb);
    maxSum += Math.max(wa, wb);
  }
  for (const [key, wb] of b) {
    if (!a.has(key)) maxSum += wb;
  }
  return maxSum === 0 ? 0 : minSum / maxSum;
}

/** Shared keys ordered by the weaker of the two weights (how much both people care), then by key. */
export function sharedKeys(a: WeightVector, b: WeightVector): string[] {
  const shared: [string, number][] = [];
  for (const [key, wa] of a) {
    const wb = b.get(key);
    if (wb !== undefined) shared.push([key, Math.min(wa, wb)]);
  }
  return shared.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k]) => k);
}

export function normalizeWeights(w: MatchWeights): MatchWeights {
  if (w.artists < 0 || w.genres < 0) throw new Error("Match weights must be non-negative");
  const total = w.artists + w.genres;
  if (total === 0) throw new Error("At least one match weight must be positive");
  return { artists: w.artists / total, genres: w.genres / total };
}

/**
 * Combines artist and genre similarity into one score. If either person has no genre data
 * (Spotify can return artists without genres), the genre term is dropped and the artist
 * score carries the full weight, instead of dragging everyone toward zero.
 */
export function scoreMatch(a: Taste, b: Taste, weights: MatchWeights): MatchScore {
  const artistScore = weightedJaccard(a.artists, b.artists);
  const genreScore = weightedJaccard(a.genres, b.genres);
  const hasGenres = a.genres.size > 0 && b.genres.size > 0;

  let w = normalizeWeights(weights);
  if (!hasGenres && w.artists > 0) w = { artists: 1, genres: 0 };

  return {
    score: w.artists * artistScore + w.genres * genreScore,
    artistScore,
    genreScore,
    sharedArtists: sharedKeys(a.artists, b.artists),
    sharedGenres: sharedKeys(a.genres, b.genres),
  };
}
