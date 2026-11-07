import type { SpotifyArtist } from "./client";

export interface WeightedArtist {
  id: string;
  name: string;
  /** 0-based position in the user's Spotify top-artists list. */
  rank: number;
  weight: number;
}

export interface WeightedGenre {
  genre: string;
  weight: number;
}

export interface TasteProfile {
  artists: WeightedArtist[];
  genres: WeightedGenre[];
}

/** Linear rank decay: the #1 artist weighs 1, the last of N weighs 1/N. */
export function rankWeight(rank: number, total: number): number {
  if (total <= 0 || rank < 0 || rank >= total) return 0;
  return (total - rank) / total;
}

export const normalizeGenre = (g: string) => g.trim().toLowerCase();

/**
 * Turns a Spotify top-artists list into weighted artist and genre vectors.
 * A genre's weight is the sum of the weights of the top artists tagged with it,
 * scaled so the user's strongest genre is 1.
 */
export function buildTasteProfile(topArtists: SpotifyArtist[]): TasteProfile {
  const seen = new Set<string>();
  const unique: SpotifyArtist[] = [];
  for (const a of topArtists) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      unique.push(a);
    }
  }

  const artists = unique.map((a, rank) => ({
    id: a.id,
    name: a.name,
    rank,
    weight: rankWeight(rank, unique.length),
  }));

  const genreTotals = new Map<string, number>();
  unique.forEach((a, i) => {
    const w = artists[i]!.weight;
    for (const g of new Set(a.genres.map(normalizeGenre).filter(Boolean))) {
      genreTotals.set(g, (genreTotals.get(g) ?? 0) + w);
    }
  });
  const max = Math.max(0, ...genreTotals.values());
  const genres = [...genreTotals]
    .map(([genre, total]) => ({ genre, weight: max > 0 ? total / max : 0 }))
    .sort((a, b) => b.weight - a.weight || a.genre.localeCompare(b.genre));

  return { artists, genres };
}
