/**
 * First-time setup: creates .env from .env.example with freshly generated secrets.
 * Never overwrites an existing .env; only fills in secrets that are still blank.
 *
 *   npm run setup
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

const secret = () => randomBytes(48).toString("base64url");
const created = !existsSync(envPath);
let text = readFileSync(created ? examplePath : envPath, "utf8");

const filled: string[] = [];
for (const key of ["JWT_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
  const blank = new RegExp(`^${key}=\\s*$`, "m");
  if (blank.test(text)) {
    text = text.replace(blank, `${key}=${secret()}`);
    filled.push(key);
  }
}
writeFileSync(envPath, text);

console.log(created ? "Created .env from .env.example." : "Found an existing .env; left your settings alone.");
if (filled.length) console.log(`Generated ${filled.join(" and ")}.`);

const missing = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"].filter((k) =>
  new RegExp(`^${k}=\\s*$`, "m").test(text),
);
if (missing.length) {
  console.log(`
Next: create a Spotify app and put its credentials in .env (${missing.join(", ")}).
  1. https://developer.spotify.com/dashboard -> Create app (choose "Web API")
  2. Redirect URI: http://127.0.0.1:3000/auth/spotify/callback
  3. Settings -> User Management: add the Spotify account(s) that will log in
Then run "npm run db" in one terminal and "npm run dev" in another, and open http://127.0.0.1:3000`);
} else {
  console.log(`\nReady. Run "npm run db" in one terminal and "npm run dev" in another, then open http://127.0.0.1:3000`);
}
