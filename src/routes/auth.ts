import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { badRequest, HttpError } from "../errors";
import type { AuthService } from "../services/auth";

const STATE_COOKIE = "tuned_oauth_state";

const callbackQuery = z.union([
  z.object({ code: z.string().min(1), state: z.string().min(1) }),
  z.object({ error: z.string().min(1), state: z.string().optional() }),
]);

function statesMatch(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function authRoutes(auth: AuthService, opts: { secureCookies: boolean; appRedirectUrl: string }): Router {
  const router = Router();

  // Step 1: send the user to Spotify. The state value ties the callback to this browser (CSRF protection).
  router.get("/spotify/login", (_req, res) => {
    const state = randomBytes(16).toString("hex");
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: opts.secureCookies,
      maxAge: 10 * 60 * 1000,
      path: "/auth/spotify",
    });
    res.redirect(auth.loginUrl(state));
  });

  // Step 2: Spotify redirects back here with a one-time code.
  router.get("/spotify/callback", async (req, res) => {
    let result;
    try {
      const query = callbackQuery.safeParse(req.query);
      if (!query.success) throw badRequest("invalid_callback", "Missing code or state");
      if ("error" in query.data) {
        throw badRequest("spotify_denied", `Spotify login was not completed: ${query.data.error}`);
      }

      const expected = req.cookies?.[STATE_COOKIE] as string | undefined;
      res.clearCookie(STATE_COOKIE, { path: "/auth/spotify" });
      if (!statesMatch(expected, query.data.state)) throw badRequest("invalid_state", "OAuth state did not match");

      result = await auth.completeLogin(query.data.code);
    } catch (err) {
      // With a client app, send expected login failures back to it so it can show them,
      // instead of leaving the user on a raw JSON error page.
      if (opts.appRedirectUrl && err instanceof HttpError) {
        const params = new URLSearchParams({ error: err.code, message: err.message });
        return res.redirect(`${opts.appRedirectUrl}#${params}`);
      }
      throw err;
    }

    if (opts.appRedirectUrl) {
      // A fragment never reaches server logs or Referer headers.
      const params = new URLSearchParams({ token: result.token, tasteSynced: String(result.tasteSynced) });
      return res.redirect(`${opts.appRedirectUrl}#${params}`);
    }
    res.json({ token: result.token, tasteSynced: result.tasteSynced, user: result.user });
  });

  return router;
}
