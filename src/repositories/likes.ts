import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { orderedPair } from "./sql";

export type Decision = "like" | "pass";

export interface MatchRow {
  id: string;
  userA: string;
  userB: string;
  score: number;
  createdAt: Date;
}

interface DbMatchRow {
  id: string;
  user_a: string;
  user_b: string;
  score: number;
  created_at: Date;
}

const toMatch = (r: DbMatchRow): MatchRow => ({
  id: r.id,
  userA: r.user_a,
  userB: r.user_b,
  score: Number(r.score),
  createdAt: new Date(r.created_at),
});

/** Records (or changes) the liker's decision about the likee. */
export async function recordDecision(q: Queryable, likerId: string, likeeId: string, kind: Decision): Promise<void> {
  await q.query(
    `INSERT INTO likes (liker_id, likee_id, kind) VALUES ($1, $2, $3)
     ON CONFLICT (liker_id, likee_id) DO UPDATE SET kind = EXCLUDED.kind, created_at = now()`,
    [likerId, likeeId, kind],
  );
}

export async function getDecision(q: Queryable, likerId: string, likeeId: string): Promise<Decision | null> {
  const { rows } = await q.query<{ kind: Decision }>(
    "SELECT kind FROM likes WHERE liker_id = $1 AND likee_id = $2",
    [likerId, likeeId],
  );
  return rows[0]?.kind ?? null;
}

export async function findMatchBetween(q: Queryable, a: string, b: string): Promise<MatchRow | null> {
  const [userA, userB] = orderedPair(a, b);
  const { rows } = await q.query<DbMatchRow>(
    "SELECT id, user_a, user_b, score, created_at FROM matches WHERE user_a = $1 AND user_b = $2",
    [userA, userB],
  );
  return rows[0] ? toMatch(rows[0]) : null;
}

/** Creates the match for a pair, or returns the existing one. */
export async function createMatch(q: Queryable, a: string, b: string, score: number): Promise<MatchRow> {
  const [userA, userB] = orderedPair(a, b);
  const { rows } = await q.query<DbMatchRow>(
    `INSERT INTO matches (id, user_a, user_b, score) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_a, user_b) DO NOTHING
     RETURNING id, user_a, user_b, score, created_at`,
    [randomUUID(), userA, userB, score],
  );
  if (rows[0]) return toMatch(rows[0]);
  return (await findMatchBetween(q, userA, userB))!;
}

export async function listMatchesForUser(q: Queryable, userId: string): Promise<MatchRow[]> {
  const { rows } = await q.query<DbMatchRow>(
    `SELECT id, user_a, user_b, score, created_at FROM matches
     WHERE user_a = $1 OR user_b = $1
     ORDER BY created_at DESC, id`,
    [userId],
  );
  return rows.map(toMatch);
}
