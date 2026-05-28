-- WordsExpire schema (D1 / SQLite)
-- All timestamps are unix epoch seconds, which keeps the decay math simple.

CREATE TABLE IF NOT EXISTS flowers (
  id          TEXT PRIMARY KEY,
  max_petals  INTEGER NOT NULL DEFAULT 6,
  created_at  INTEGER NOT NULL,
  theme       TEXT
);

CREATE TABLE IF NOT EXISTS petals (
  id              TEXT PRIMARY KEY,
  flower_id       TEXT NOT NULL REFERENCES flowers(id),
  text            TEXT NOT NULL,
  color           TEXT NOT NULL,            -- a petal color key (rose, sage, ...)
  created_at      INTEGER NOT NULL,
  spoken_at       INTEGER NOT NULL,         -- when the words were first said (may predate the note)
  medium          TEXT,                     -- how the words passed: in_person, text, call, video, email, letter, other
  direction       TEXT,                     -- 'gave' (said it) or 'received' (heard it)
  relationship    TEXT,                     -- to or from whom: partner, parent, friend, ...
  image_id        TEXT,                     -- optional image, stored in the images table
  is_example      INTEGER NOT NULL DEFAULT 0, -- a seeded example, not a real submission
  last_renewed_at INTEGER NOT NULL,         -- a reaction resets this to now
  reaction_count  INTEGER NOT NULL DEFAULT 0,
  deleted_at      INTEGER                   -- soft-delete once a petal is long gone
);

CREATE TABLE IF NOT EXISTS reactions (
  id          TEXT PRIMARY KEY,
  petal_id    TEXT NOT NULL REFERENCES petals(id),
  ip_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Anonymous replies left on a petal. No author is recorded, only a salted
-- hash of the IP, used for rate limiting and moderation.
CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  petal_id    TEXT NOT NULL REFERENCES petals(id),
  text        TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comments_petal ON comments(petal_id, created_at);

-- Quiet community flags on a note or reply, for the keeper to review.
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,   -- 'petal' | 'comment'
  target_id   TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);

-- Optional images live in R2 (bucket binding IMAGES); petals.image_id holds the key.

-- A light footprint for rate limiting, keyed by a salted hash of the IP.
CREATE TABLE IF NOT EXISTS rate_events (
  ip_hash     TEXT NOT NULL,
  action      TEXT NOT NULL,                -- 'petal' | 'react' | 'flower'
  created_at  INTEGER NOT NULL
);

-- Presence: one row per open tab. A fish lingers after someone leaves for a
-- multiple of how long they stayed, so the pond feels gently alive.
CREATE TABLE IF NOT EXISTS presence (
  id            TEXT PRIMARY KEY,
  first_seen    INTEGER NOT NULL,
  linger_until  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_petals_flower      ON petals(flower_id);
CREATE INDEX IF NOT EXISTS idx_petals_renewed     ON petals(last_renewed_at);
CREATE INDEX IF NOT EXISTS idx_reactions_petal_ip ON reactions(petal_id, ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_events        ON rate_events(ip_hash, action, created_at);
