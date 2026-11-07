import jwt from "jsonwebtoken";

const ISSUER = "tuned";
const SESSION_TTL = "7d";

export function signSession(secret: string, userId: string): string {
  return jwt.sign({}, secret, { subject: userId, issuer: ISSUER, expiresIn: SESSION_TTL, algorithm: "HS256" });
}

/** Returns the user id from a valid session token, or null if it is missing, expired, or forged. */
export function verifySession(secret: string, token: string): string | null {
  try {
    const payload = jwt.verify(token, secret, { issuer: ISSUER, algorithms: ["HS256"] });
    return typeof payload === "object" && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
