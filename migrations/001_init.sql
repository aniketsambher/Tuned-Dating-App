-- Profiles. Spotify tokens are stored encrypted (AES-256-GCM, see src/crypto.ts).
CREATE TABLE users (
  id                        UUID PRIMARY KEY,
  spotify_id                TEXT NOT NULL UNIQUE,
  display_name              TEXT NOT NULL,
  email                     TEXT,
  avatar_url                TEXT,
  bio                       TEXT NOT NULL DEFAULT '',
  spotify_access_token      TEXT,
  spotify_refresh_token     TEXT,
  spotify_token_expires_at  TIMESTAMPTZ,
  taste_synced_at           TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A user's top artists from Spotify, with a rank-based weight in (0, 1].
CREATE TABLE user_artists (
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spotify_artist_id  TEXT NOT NULL,
  name               TEXT NOT NULL,
  rank               INTEGER NOT NULL,
  weight             DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (user_id, spotify_artist_id)
);
CREATE INDEX user_artists_artist_idx ON user_artists (spotify_artist_id);

-- Genres derived from the user's top artists, weighted and normalized to max 1.
CREATE TABLE user_genres (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  genre    TEXT NOT NULL,
  weight   DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (user_id, genre)
);
CREATE INDEX user_genres_genre_idx ON user_genres (genre);

-- One decision per (liker, likee) pair: 'like' or 'pass'. A pass can later become a like.
CREATE TABLE likes (
  liker_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  likee_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('like', 'pass')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (liker_id, likee_id),
  CHECK (liker_id <> likee_id)
);
CREATE INDEX likes_likee_idx ON likes (likee_id);

-- A mutual like. The pair is stored in a canonical order (user_a < user_b) so it is unique.
CREATE TABLE matches (
  id          UUID PRIMARY KEY,
  user_a      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score       DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX matches_user_b_idx ON matches (user_b);
