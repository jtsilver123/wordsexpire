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

-- A light footprint for rate limiting, keyed by a salted hash of the IP.
CREATE TABLE IF NOT EXISTS rate_events (
  ip_hash     TEXT NOT NULL,
  action      TEXT NOT NULL,                -- 'petal' | 'react' | 'flower'
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_petals_flower      ON petals(flower_id);
CREATE INDEX IF NOT EXISTS idx_petals_renewed     ON petals(last_renewed_at);
CREATE INDEX IF NOT EXISTS idx_reactions_petal_ip ON reactions(petal_id, ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_events        ON rate_events(ip_hash, action, created_at);
