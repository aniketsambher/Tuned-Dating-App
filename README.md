# Tuned

A dating app that matches people on music taste. You sign in with Spotify; Tuned reads your top artists,
ranks everyone else by a weighted similarity score, and lets you like or pass. When two people like each
other, it's a match.

It's a TypeScript/Node.js backend with a PostgreSQL database and a small web UI, built to run on your own machine.

**Stack:** TypeScript, Node.js, Express 5, PostgreSQL, Spotify Web API (OAuth 2.0 authorization code flow),
Vitest + Supertest, GitHub Actions. A plain HTML/CSS/JS front end with no build step.

## Quick start

You need **Node.js 22.9 or newer** (24 recommended) and a free Spotify account. Docker is optional.

**1. Install and create your config**

```bash
git clone <this repo> tuned
```

```bash
cd tuned
```

```bash
npm install
```

```bash
npm run setup
```

`npm run setup` creates `.env` with freshly generated secrets. It never overwrites an existing `.env`.

**2. Create a Spotify app** (one time)

1. Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and click **Create app**.
   Choose **Web API**.
2. Add this redirect URI exactly: `http://127.0.0.1:3000/auth/spotify/callback`
   (Spotify doesn't accept `localhost`; use `127.0.0.1`).
3. In the app's **Settings → User Management**, add the name and email of every Spotify account that will
   log in, including your own. Apps in development mode refuse anyone not on this list.
4. Copy the app's **Client ID** and **Client secret** into `.env` (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`).

**3. Run it** in two terminals:

```bash
npm run db
```

```bash
npm run dev
```

`npm run db` starts a local PostgreSQL server with no Docker needed; its data lives in `.pgdata/`.
`npm run dev` starts the app, applies database migrations, and restarts when you change code or `.env`.

Open **http://127.0.0.1:3000** and click **Log in with Spotify**.

**4. Add people to match with**

If you're the only person who has logged in, Discover will be empty. After your first login, create demo users:

```bash
npm run seed
```

The demo users share some of your real top artists and have already liked you, so liking one back
shows the match screen.

### Using Docker for the database instead

If you prefer Docker, `docker compose up -d db` starts Postgres 17 on the same port with the same credentials.
Use it *instead of* `npm run db`, not alongside it. `docker compose up --build` runs the database and the app together.

## Features

- **Spotify login** using the OAuth authorization code flow, with CSRF protection on the `state` parameter
- **Taste sync:** your top 50 artists, weighted by rank. Re-sync any time from your profile.
- **Discover:** people ranked by taste similarity, showing the artists you share. Like or pass with buttons or ← / →.
- **Matches** created the moment a like is mutual, even when both people like each other at the same instant
- **Profile:** edit your display name and bio
- **JSON API** behind all of it ([below](#api)), so you can build your own client

## How matching works

Each user's top artists become a weight vector with linear rank decay: the #1 artist weighs 1 and the last
of N weighs 1/N. When Spotify provides genres, a genre's weight is the sum of the weights of the artists tagged
with it, scaled so the strongest genre is 1.

Two people are compared with **weighted Jaccard similarity**:

```
J(a, b) = Σ min(aᵢ, bᵢ) / Σ max(aᵢ, bᵢ)        over the union of artists (or genres)

score = 0.6 · J(artists) + 0.4 · J(genres)
```

Weighted Jaccard rewards sharing each other's *favorite* artists more than sharing someone's long tail.
It's symmetric and always between 0 and 1. Ties go to the person with more shared artists. The weights are
configurable with `MATCH_ARTIST_WEIGHT` and `MATCH_GENRE_WEIGHT`. The code is in
[src/matching/similarity.ts](src/matching/similarity.ts).

> **About genres:** Spotify currently doesn't return artist genres to apps in development mode, which is
> every personal app. When either person has no genre data, the genre term is dropped and the score uses
> artists alone, so missing data doesn't drag scores toward zero. If Spotify provides genres, they count automatically.

```
Spotify OAuth ─▶ /auth/spotify/callback ─▶ upsert user, encrypt + store tokens
                                        └▶ GET /me/top/artists (50, medium_term)
                                             └▶ weighted artist (+ genre) vectors ─▶ PostgreSQL

GET /discover ─▶ SQL prefilter (shares ≥1 artist or genre, not yet liked/passed)
              └▶ weighted-Jaccard score in the app ─▶ ranked candidates

POST /likes ─▶ lock both users ─▶ record like ─▶ liked back? ─▶ create match (one row per pair)
```

### Data model

| Table          | Purpose |
| -------------- | ------- |
| `users`        | Profile plus encrypted Spotify access/refresh tokens and `taste_synced_at` |
| `user_artists` | A user's top artists with rank and weight |
| `user_genres`  | Derived genre weights (when Spotify provides genres) |
| `likes`        | One decision per (liker, likee): `like` or `pass` |
| `matches`      | One row per mutual pair, stored as `user_a < user_b` so a pair can't be duplicated |

Schema: [migrations/001_init.sql](migrations/001_init.sql).

### Correctness and security details

- **Simultaneous likes:** `POST /likes` locks both users' rows (in id order, so it can't deadlock) before
  checking for a like-back. Two people liking each other at the same instant get exactly one match. An
  integration test covers this against real Postgres in CI.
- **OAuth CSRF:** the `state` parameter is bound to the browser with an httpOnly cookie and compared in constant time.
- **Tokens at rest:** Spotify tokens are encrypted with AES-256-GCM before they reach the database. Access
  tokens refresh a minute before expiry, and a sync retries once with a forced refresh if Spotify rejects the token.
- **Resilient login:** if reading top artists fails during login, you're still signed in and can retry the sync.
- **Sessions:** HS256 JWTs (7 days), handed to the web UI in the URL *fragment*, which never reaches server
  logs or `Referer` headers. The UI is served with a strict Content-Security-Policy, and user-written text is
  always inserted as text, never as HTML.

## API

All routes except `/health` and `/auth/*` need `Authorization: Bearer <token>`.

| Method  | Path                     | Description |
| ------- | ------------------------ | ----------- |
| `GET`   | `/health`                | Health check, including the database |
| `GET`   | `/auth/spotify/login`    | Redirects to Spotify's consent screen |
| `GET`   | `/auth/spotify/callback` | Completes login, then redirects to `APP_REDIRECT_URL#token=…`, or returns `{ token, user, tasteSynced }` as JSON when it's empty |
| `GET`   | `/me`                    | Your profile plus top 10 artists and genres |
| `PATCH` | `/me`                    | Update `displayName` (1–50 chars) and/or `bio` (≤ 500 chars) |
| `POST`  | `/me/sync`               | Re-pull top artists from Spotify |
| `GET`   | `/discover?limit=20`     | Ranked candidates with `compatibility` and shared artists/genres (`limit` 1–50) |
| `POST`  | `/likes`                 | `{ "userId": "<uuid>" }` returns `200 { matched: false }` or `201 { matched: true, match }` |
| `POST`  | `/passes`                | `{ "userId": "<uuid>" }` hides them from discover (`409` if already matched) |
| `GET`   | `/matches`               | Your matches, newest first |

Errors always look like `{ "error": { "code": "taste_not_synced", "message": "..." } }`.

Example `/discover` item:

```json
{
  "user": { "id": "…", "displayName": "Quinn", "bio": "", "avatarUrl": null },
  "compatibility": {
    "score": 0.287,
    "artistScore": 0.287,
    "genreScore": 0,
    "sharedArtists": [{ "id": "…", "name": "The Neighbourhood" }, { "id": "…", "name": "The Weeknd" }],
    "sharedGenres": []
  }
}
```

## Tests

```bash
npm test
```

- **Unit** (`test/unit`): similarity math, taste weighting, token encryption, and the Spotify HTTP client
  (with a stubbed `fetch`: request shape, 429 retry, token and permission errors, missing genres).
- **Integration** (`test/integration`): the whole Express app through Supertest, covering the full OAuth flow
  with state cookies, taste sync, token refresh on expiry, discover ranking, likes/passes/matches and their
  edge cases, and the web UI being served. Spotify is replaced by an in-memory fake that issues expiring
  tokens like the real one.

Integration tests use [pg-mem](https://github.com/oguimbal/pg-mem), an in-memory Postgres emulator, by
default, so they need no setup. To run them against real Postgres, as CI does:

```bash
TEST_DATABASE_URL=postgres://tuned:tuned@localhost:5432/tuned_test npm test
```

That database's `public` schema is dropped and recreated for each test, so point it at a database you don't need.

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| Spotify page says **INVALID_CLIENT: Invalid redirect URI** | The redirect URI in the Spotify dashboard must be exactly `http://127.0.0.1:3000/auth/spotify/callback`. Click **Save** after adding it. |
| **Spotify refused /me (403) … user may not be registered** | Add that Spotify account's email under **Settings → User Management** in the dashboard. If your browser is signed in to a different Spotify account, log out at spotify.com first. |
| **client_id: Invalid** | `.env` still has placeholder credentials, or a typo in `SPOTIFY_CLIENT_ID`. |
| `npm run db` fails because port 5432 is in use | Another Postgres is running. Stop it, or run `PGPORT_DEV=5433 npm run db` and change the port in `DATABASE_URL`. |
| Discover is empty | You're the only user. Run `npm run seed` after logging in once. |

## Project layout

```
public/                Web UI (index.html, app.js, app.css), served at /
src/
  app.ts               Express app wiring (dependency-injected for tests)
  server.ts            Entry point: config, migrations, graceful shutdown
  config.ts            Environment validation with zod
  crypto.ts            AES-256-GCM token encryption
  migrate.ts           SQL migration runner (advisory-locked)
  spotify/client.ts    Spotify accounts + Web API client
  spotify/taste.ts     Top artists → weighted artist/genre vectors
  matching/similarity.ts  Weighted Jaccard + combined score (pure functions)
  services/            Auth, token refresh, taste sync, matching, likes
  repositories/        SQL for users, tastes, likes/matches
  routes/              HTTP handlers + request validation
migrations/            Database schema
scripts/               setup (create .env), db (local Postgres), seed (demo users)
test/unit, test/integration
```
