import type { Queryable } from "../db";
import { conflict, notFound } from "../errors";
import { type MatchScore, type MatchWeights, normalizeWeights, scoreMatch } from "../matching/similarity";
import { loadTastes, type StoredTaste } from "../repositories/tastes";
import { findCandidateIds, findUserById, findUsersByIds, type PublicProfile, toPublicProfile } from "../repositories/users";

/** How many shared artists/genres to show per match card. */
const SHARED_PREVIEW = 5;
/** Upper bound on candidates scored per discover request. */
const CANDIDATE_POOL = 500;

export interface Compatibility {
  score: number;
  artistScore: number;
  genreScore: number;
  sharedArtists: { id: string; name: string }[];
  sharedGenres: string[];
}

export interface RankedCandidate {
  user: PublicProfile;
  compatibility: Compatibility;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function toCompatibility(score: MatchScore, names: ReadonlyMap<string, string>): Compatibility {
  return {
    score: round(score.score),
    artistScore: round(score.artistScore),
    genreScore: round(score.genreScore),
    sharedArtists: score.sharedArtists.slice(0, SHARED_PREVIEW).map((id) => ({ id, name: names.get(id) ?? id })),
    sharedGenres: score.sharedGenres.slice(0, SHARED_PREVIEW),
  };
}

export class MatchingService {
  private readonly weights: MatchWeights;

  constructor(
    private readonly db: Queryable,
    weights: MatchWeights,
  ) {
    this.weights = normalizeWeights(weights);
  }

  /** Candidates ranked by music compatibility, best first. Ties go to more shared artists. */
  async discover(userId: string, limit: number): Promise<RankedCandidate[]> {
    const me = await findUserById(this.db, userId);
    if (!me) throw notFound("User not found");
    if (!me.tasteSyncedAt) throw conflict("taste_not_synced", "Sync your Spotify taste first (POST /me/sync)");

    const candidateIds = await findCandidateIds(this.db, userId, CANDIDATE_POOL);
    if (candidateIds.length === 0) return [];

    const [tastes, users] = await Promise.all([
      loadTastes(this.db, [userId, ...candidateIds]),
      findUsersByIds(this.db, candidateIds),
    ]);
    const mine = tastes.get(userId)!;

    return candidateIds
      .map((id) => {
        const theirs = tastes.get(id)!;
        return { id, raw: scoreMatch(mine, theirs, this.weights), names: theirs.artistNames };
      })
      .filter((c) => c.raw.score > 0 && users.has(c.id))
      .sort(
        (a, b) =>
          b.raw.score - a.raw.score ||
          b.raw.sharedArtists.length - a.raw.sharedArtists.length ||
          a.id.localeCompare(b.id),
      )
      .slice(0, limit)
      .map((c) => ({ user: toPublicProfile(users.get(c.id)!), compatibility: toCompatibility(c.raw, c.names) }));
  }

  /** Compatibility between two users, computed from their stored tastes. */
  async compatibility(q: Queryable, a: string, b: string): Promise<Compatibility> {
    const tastes = await loadTastes(q, [a, b]);
    return this.compatibilityFrom(tastes.get(a)!, tastes.get(b)!);
  }

  compatibilityFrom(a: StoredTaste, b: StoredTaste): Compatibility {
    return toCompatibility(scoreMatch(a, b, this.weights), b.artistNames);
  }
}
