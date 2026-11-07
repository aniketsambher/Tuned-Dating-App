# Tuned 🎧

A dating app that matches people on music taste.

<!-- ✏️ Make this yours: a line or two on why you built it. For example: -->
I built Tuned because _[your reason, e.g. "the best conversations I've had started with 'wait, you listen to them too?'"]_.
You log in with Spotify, it reads your top artists, and it ranks people by how much your listening overlaps.
Like someone who liked you back, and it's a match.

**Built with:** TypeScript, Node.js, Express, PostgreSQL, the Spotify Web API (OAuth), Vitest

## Run it locally

You'll need [Node.js](https://nodejs.org) 22.9+ and a Spotify account.

```bash
git clone https://github.com/<your-username>/tuned.git
```

```bash
cd tuned && npm install && npm run setup
```

Then create a Spotify app (it's free) at the [developer dashboard](https://developer.spotify.com/dashboard):

1. Choose **Web API** and add the redirect URI `http://127.0.0.1:3000/auth/spotify/callback`
2. Under **User Management**, add the email of every Spotify account that will log in (including yours)
3. Paste the **Client ID** and **Client secret** into `.env`

Start the database and the app in two terminals:

```bash
npm run db
```

```bash
npm run dev
```

Open http://127.0.0.1:3000 and log in. To have people to match with, run `npm run seed` after your first
login. It adds demo users who share some of your artists and have already liked you.

## How matching works

Your top 50 artists become a weighted list: your #1 artist counts the most, your #50 the least. Two people
are compared with **weighted Jaccard similarity**, so sharing each other's favorites counts for more than
sharing someone's 40th artist. The scoring is in [src/matching/similarity.ts](src/matching/similarity.ts).

Genres are supported too, but Spotify doesn't currently share them with personal apps, so in practice
matching is based on artists.

A few details I cared about:
- If two people like each other at the same moment, they still get exactly one match.
- Spotify tokens are encrypted in the database and refreshed automatically.
- Login is protected against CSRF, and the UI never renders user text as HTML.

## Tests

```bash
npm test
```

73 unit and integration tests cover the scoring, the Spotify login flow, and the like/match logic.
They run on an in-memory database, so no setup is needed. CI also runs them against real PostgreSQL.

## Common issues

- **"Invalid redirect URI":** the URI in the Spotify dashboard must match exactly, using `127.0.0.1`, not `localhost`.
- **"403 … user may not be registered":** add that Spotify account under **User Management**.
- **Discover is empty:** you're the only user. Run `npm run seed`.
