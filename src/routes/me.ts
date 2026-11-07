import { Router } from "express";
import { z } from "zod";
import { currentUserId } from "../auth/middleware";
import type { Database } from "../db";
import { notFound } from "../errors";
import { loadTastes } from "../repositories/tastes";
import { findUserById, updateProfile } from "../repositories/users";
import type { TasteSyncService } from "../services/tasteSync";

const profilePatch = z
  .object({
    displayName: z.string().trim().min(1).max(50).optional(),
    bio: z.string().trim().max(500).optional(),
  })
  .strict();

export function meRoutes(db: Database, tasteSync: TasteSyncService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const userId = currentUserId(req);
    const user = await findUserById(db, userId);
    if (!user) throw notFound("User not found");
    const taste = (await loadTastes(db, [userId])).get(userId)!;
    const topArtists = [...taste.artists]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => ({ id, name: taste.artistNames.get(id) ?? id }));
    const topGenres = [...taste.genres]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([genre]) => genre);
    res.json({ user, taste: { topArtists, topGenres } });
  });

  router.patch("/", async (req, res) => {
    const patch = profilePatch.parse(req.body ?? {});
    const user = await updateProfile(db, currentUserId(req), patch);
    if (!user) throw notFound("User not found");
    res.json({ user });
  });

  // Re-pull top artists from Spotify (tastes change; also the retry path if sync failed at login).
  router.post("/sync", async (req, res) => {
    const result = await tasteSync.sync(currentUserId(req));
    res.json(result);
  });

  return router;
}
