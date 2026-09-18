-- lmjtfy: one row per distinct yes/no question Jev has ruled on.

CREATE TABLE questions (
  id            TEXT PRIMARY KEY,          -- sha256 of normalized, first 32 hex chars
  text          TEXT NOT NULL,             -- canonical display text (as first asked)
  normalized    TEXT NOT NULL UNIQUE,      -- normalization key used for exact grouping
  noul          REAL NOT NULL,             -- Jev's probability that the answer is yes
  verdict       TEXT NOT NULL,             -- bucketed label derived from noul
  topic         TEXT NOT NULL,             -- Choice label, used for sidebar filtering
  settledness   REAL NOT NULL,             -- Score: 0 = pure taste .. 3 = established fact
  ask_count     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,          -- unix ms
  last_asked_at INTEGER NOT NULL
);

CREATE INDEX questions_last_asked ON questions (last_asked_at DESC);
CREATE INDEX questions_ask_count ON questions (ask_count DESC, last_asked_at DESC);
CREATE INDEX questions_topic ON questions (topic, last_asked_at DESC);

-- Differently-worded questions that Jev judged to be asking the same thing.
CREATE TABLE question_aliases (
  normalized  TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  similarity  REAL NOT NULL,               -- Jev's "same question" probability
  created_at  INTEGER NOT NULL
);

CREATE INDEX question_aliases_question ON question_aliases (question_id);

-- Full-text index over canonical questions, used to pull dedup candidates
-- before asking Jev whether any of them mean the same thing.
CREATE VIRTUAL TABLE questions_fts USING fts5(
  id UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);

-- Per-IP daily quota on asks that actually reach Jev. IPs are salted-hashed,
-- never stored in the clear, and rows are pruned by day.
CREATE TABLE ip_quota (
  ip_hash TEXT NOT NULL,
  day     TEXT NOT NULL,                   -- UTC YYYY-MM-DD
  used    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);

CREATE INDEX ip_quota_day ON ip_quota (day);

-- Aggregate-only record of what the safety gate turned away. No question text
-- is retained: we keep counts so the thresholds can be tuned, nothing more.
CREATE TABLE gate_rejections (
  day    TEXT NOT NULL,
  reason TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, reason)
);
