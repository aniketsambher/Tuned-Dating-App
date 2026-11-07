import { type Database, type Queryable, withTransaction } from "../db";
import { badRequest, conflict, notFound, unauthorized } from "../errors";
import {
  createMatch,
  findMatchBetween,
  getDecision,
  listMatchesForUser,
  type MatchRow,
  recordDecision,
} from "../repositories/likes";
import { loadTastes } from "../repositories/tastes";
import { findUsersByIds, lockUsers, type PublicProfile, toPublicProfile } from "../repositories/users";
import type { Compatibility, MatchingService } from "./matching";

export interface MatchView {
  id: string;
  user: PublicProfile;
  compatibility: Compatibility;
  createdAt: Date;
}

export interface LikeResult {
  matched: boolean;
  match: MatchView | null;
}

export class LikeService {
  constructor(
    private readonly db: Database,
    private readonly matching: MatchingService,
  ) {}

  /**
   * Likes another user. If they already liked back, creates the match in the same transaction.
   * Both user rows are locked first so two people liking each other at the same moment
   * still produce exactly one match.
   */
  async like(userId: string, targetId: string): Promise<LikeResult> {
    if (userId === targetId) throw badRequest("cannot_like_self", "You can't like yourself");

    const match = await withTransaction(this.db, async (tx) => {
      await this.lockPair(tx, userId, targetId);

      await recordDecision(tx, userId, targetId, "like");
      if ((await getDecision(tx, targetId, userId)) !== "like") return null;

      const existing = await findMatchBetween(tx, userId, targetId);
      if (existing) return existing;
      const { score } = await this.matching.compatibility(tx, userId, targetId);
      return createMatch(tx, userId, targetId, score);
    });

    if (!match) return { matched: false, match: null };
    const [view] = await this.toViews(userId, [match]);
    return { matched: true, match: view ?? null };
  }

  /** Passes on a user so they stop appearing in discover. Not allowed once you've matched. */
  async pass(userId: string, targetId: string): Promise<void> {
    if (userId === targetId) throw badRequest("cannot_pass_self", "You can't pass on yourself");
    await withTransaction(this.db, async (tx) => {
      await this.lockPair(tx, userId, targetId);
      if (await findMatchBetween(tx, userId, targetId)) {
        throw conflict("already_matched", "You're already matched with this user");
      }
      await recordDecision(tx, userId, targetId, "pass");
    });
  }

  async listMatches(userId: string): Promise<MatchView[]> {
    return this.toViews(userId, await listMatchesForUser(this.db, userId));
  }

  private async lockPair(tx: Queryable, userId: string, targetId: string): Promise<void> {
    const found = await lockUsers(tx, [userId, targetId]);
    // A valid session for a deleted account.
    if (!found.has(userId)) throw unauthorized("Account no longer exists");
    if (!found.has(targetId)) throw notFound("User not found");
  }

  private async toViews(userId: string, matches: MatchRow[]): Promise<MatchView[]> {
    if (matches.length === 0) return [];
    const otherIds = matches.map((m) => (m.userA === userId ? m.userB : m.userA));
    const [users, tastes] = await Promise.all([
      findUsersByIds(this.db, otherIds),
      loadTastes(this.db, [userId, ...otherIds]),
    ]);
    const mine = tastes.get(userId)!;
    return matches.flatMap((m, i) => {
      const otherId = otherIds[i]!;
      const other = users.get(otherId);
      if (!other) return [];
      // The stored score is what the pair matched at; shared artists reflect current tastes.
      const compatibility = { ...this.matching.compatibilityFrom(mine, tastes.get(otherId)!), score: m.score };
      return [{ id: m.id, user: toPublicProfile(other), compatibility, createdAt: m.createdAt }];
    });
  }
}
