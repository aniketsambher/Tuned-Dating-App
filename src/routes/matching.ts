import { Router } from "express";
import { z } from "zod";
import { currentUserId } from "../auth/middleware";
import type { LikeService } from "../services/likes";
import type { MatchingService } from "../services/matching";

const discoverQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
const targetBody = z.object({ userId: z.uuid().transform((s) => s.toLowerCase()) });

export function matchingRoutes(matching: MatchingService, likes: LikeService): Router {
  const router = Router();

  router.get("/discover", async (req, res) => {
    const { limit } = discoverQuery.parse(req.query);
    res.json({ candidates: await matching.discover(currentUserId(req), limit) });
  });

  router.post("/likes", async (req, res) => {
    const { userId } = targetBody.parse(req.body ?? {});
    const result = await likes.like(currentUserId(req), userId);
    res.status(result.matched ? 201 : 200).json(result);
  });

  router.post("/passes", async (req, res) => {
    const { userId } = targetBody.parse(req.body ?? {});
    await likes.pass(currentUserId(req), userId);
    res.status(204).end();
  });

  router.get("/matches", async (req, res) => {
    res.json({ matches: await likes.listMatches(currentUserId(req)) });
  });

  return router;
}
