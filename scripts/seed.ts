/**
 * Seeds demo users with music tastes so discover has people to show when you're the only real user.
 * Run it after logging in once: every seeded user also likes every real (non-seed) user, so liking
 * a seeded user back from the API produces an instant match.
 *
 *   npm run seed            # 24 users
 *   npm run seed -- 50      # 50 users
 *
 * Artist ids are real Spotify ids, so seeded users can share artists with your actual top artists.
 * Genre overlap works either way.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createPool, withTransaction } from "../src/db";
import { migrate } from "../src/migrate";
import { replaceTaste } from "../src/repositories/tastes";
import { markTasteSynced } from "../src/repositories/users";
import { buildTasteProfile } from "../src/spotify/taste";

const ARTISTS: [id: string, name: string, genres: string[]][] = [
  ["06HL4z0CvFAxyc27GXpf02", "Taylor Swift", ["pop"]],
  ["1Xyo4u8uXC1ZmMpatF05PJ", "The Weeknd", ["r&b", "pop"]],
  ["3TVXtAsR1Inumwj472S9r4", "Drake", ["hip hop", "rap"]],
  ["2YZyLoL8N0Wb9xBt1NhZWg", "Kendrick Lamar", ["hip hop", "west coast hip hop", "rap"]],
  ["4V8LLVI7PbaPR0K2TGSxFF", "Tyler, The Creator", ["hip hop", "rap"]],
  ["2h93pZq0e7k5yf4dywlkpM", "Frank Ocean", ["r&b", "alternative r&b"]],
  ["7tYKF4w9nC0nq9CsPZTHyP", "SZA", ["r&b", "pop"]],
  ["4q3ewBCX7sLwd24euuV69X", "Bad Bunny", ["reggaeton", "latin trap", "urbano latino"]],
  ["6qqNVTkY8uBg9cP3Jd7DAH", "Billie Eilish", ["pop", "art pop"]],
  ["4Z8W4fKeB5YxbusRsdQVPb", "Radiohead", ["alternative rock", "art rock"]],
  ["7Ln80lUS6He07XvHI8qqHH", "Arctic Monkeys", ["indie rock", "garage rock"]],
  ["1r1uxoy19fzMxunt3ONAkG", "Phoebe Bridgers", ["indie folk", "indie pop"]],
  ["2uYWxilOVlUdk4oV9DvwqK", "Mitski", ["indie pop", "art pop"]],
  ["5INjqkS1o8h1imAzPqGZBb", "Tame Impala", ["psychedelic rock", "indie rock"]],
  ["0du5cEVh5yTK9QJze8zA0C", "Bruno Mars", ["pop", "funk"]],
  ["66CXWjxzNUsdJxJ2JdwvnR", "Ariana Grande", ["pop"]],
  ["0Y5tJX1MQlPlqiwlOH1tJY", "Travis Scott", ["rap", "hip hop"]],
  ["3Nrfpe0tUJi4K4DXYWgMUX", "BTS", ["k-pop"]],
  ["6eUKZXaKkcviH0Ku9w2n3V", "Ed Sheeran", ["pop", "singer-songwriter"]],
  ["0oSGxfWSnnOXhD2fKuz2Gy", "David Bowie", ["glam rock", "art rock"]],
  ["0L8ExT028jH3ddEcZwqJJ5", "Red Hot Chili Peppers", ["alternative rock", "funk rock"]],
  ["4tZwfgrHOc3mvqYlEYSvVi", "Daft Punk", ["electronic", "french house"]],
  ["0hCNtLu0JehylgoiP8L4Gh", "Nicki Minaj", ["hip hop", "rap", "pop"]],
  ["5K4W6rqBFWDnAN6FQUkS6x", "Kanye West", ["hip hop", "rap"]],
];

const NAMES = ["Ava", "Ben", "Chloe", "Diego", "Emma", "Felix", "Grace", "Hugo", "Isla", "Jay", "Kira", "Leo",
  "Maya", "Noah", "Olive", "Priya", "Quinn", "Ravi", "Sofia", "Theo", "Uma", "Vik", "Willa", "Yuki"];

/** Small deterministic PRNG so seeds are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const count = Number(process.argv[2] ?? 24);
  const db = createPool(process.env.DATABASE_URL);
  await migrate(db);
  const rand = mulberry32(42);

  const realUsers = (await db.query<{ id: string }>("SELECT id FROM users WHERE spotify_id NOT LIKE 'seed:%'")).rows;

  // Real users' top artists, so demo users actually overlap with you. Spotify doesn't always
  // return genres, so these may carry none; artist overlap alone is enough to match.
  const realArtists = (
    await db.query<{ spotify_artist_id: string; name: string }>(
      `SELECT DISTINCT a.spotify_artist_id, a.name FROM user_artists a
       JOIN users u ON u.id = a.user_id WHERE u.spotify_id NOT LIKE 'seed:%'`,
    )
  ).rows.map((r): [string, string, string[]] => [r.spotify_artist_id, r.name, []]);

  const shuffle = <T>(xs: T[]) => [...xs].sort(() => rand() - 0.5);

  for (let i = 0; i < count; i++) {
    const spotifyId = `seed:${i}`;
    // Vary how much each demo user shares with real users (0 to ~20 artists) so scores spread out.
    const fromReal = shuffle(realArtists).slice(0, Math.floor(rand() * Math.min(20, realArtists.length + 1)));
    const fromPool = shuffle(ARTISTS).slice(0, 6 + Math.floor(rand() * 10));
    const seen = new Set<string>();
    const top = shuffle([...fromReal, ...fromPool]).filter(([id]) => !seen.has(id) && (seen.add(id), true));
    const profile = buildTasteProfile(top.map(([id, name, genres]) => ({ id, name, genres })));

    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO users (id, spotify_id, display_name, bio) VALUES ($1, $2, $3, $4)
         ON CONFLICT (spotify_id) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [randomUUID(), spotifyId, `${NAMES[i % NAMES.length]} (demo)`, `Seeded demo user #${i}`],
      );
      const userId = rows[0]!.id;
      await replaceTaste(tx, userId, profile);
      await markTasteSynced(tx, userId, new Date());
      for (const real of realUsers) {
        await tx.query(
          `INSERT INTO likes (liker_id, likee_id, kind) VALUES ($1, $2, 'like') ON CONFLICT DO NOTHING`,
          [userId, real.id],
        );
      }
    });
  }
  console.log(
    `seeded ${count} demo users (each likes ${realUsers.length} real user(s); ` +
      `drew from ${realArtists.length} real top artists)`,
  );
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
