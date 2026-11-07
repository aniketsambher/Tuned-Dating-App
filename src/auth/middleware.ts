import type { NextFunction, Request, RequestHandler, Response } from "express";
import { unauthorized } from "../errors";
import { verifySession } from "./jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(jwtSecret: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    const userId = scheme === "Bearer" && token ? verifySession(jwtSecret, token) : null;
    if (!userId) return next(unauthorized());
    req.userId = userId;
    next();
  };
}

/** The authenticated user id. Only call from routes behind requireAuth. */
export function currentUserId(req: Request): string {
  if (!req.userId) throw unauthorized();
  return req.userId;
}
