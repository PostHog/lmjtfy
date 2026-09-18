import type { QuestionRow } from "./types";

/** Words too common to be worth matching on when pulling dedup candidates. */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "can", "could", "will", "would", "shall", "should",
  "may", "might", "must", "have", "has", "had", "it", "its", "this", "that",
  "these", "those", "i", "you", "he", "she", "we", "they", "me", "my", "your",
  "to", "of", "in", "on", "at", "for", "with", "and", "or", "but", "if", "as",
  "really", "actually", "ever", "still", "just", "even", "too", "so", "think",
]);

export async function findByNormalized(db: D1Database, normalized: string) {
  return db
    .prepare("SELECT * FROM questions WHERE normalized = ?")
    .bind(normalized)
    .first<QuestionRow>();
}

/** Returns the canonical question plus which way round the alias was asked. */
export async function findByAlias(db: D1Database, normalized: string) {
  return db
    .prepare(
      `SELECT q.*, a.polarity FROM question_aliases a
       JOIN questions q ON q.id = a.question_id
       WHERE a.normalized = ?`,
    )
    .bind(normalized)
    .first<QuestionRow & { polarity: number }>();
}

export async function findById(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM questions WHERE id = ?").bind(id).first<QuestionRow>();
}

/**
 * Cheap keyword shortlist for the semantic match. Retrieval stays in code —
 * Jev only judges the handful of candidates that survive, which is the whole
 * point of paying for a judgment instead of a search.
 */
export async function findCandidates(
  db: D1Database,
  normalized: string,
  limit = 6,
): Promise<{ id: string; text: string }[]> {
  const terms = normalized
    .split(" ")
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .slice(0, 12)
    .map((t) => `"${t.replace(/"/g, "")}"`);

  if (terms.length === 0) return [];

  try {
    const { results } = await db
      .prepare(
        `SELECT id, text FROM questions_fts
         WHERE questions_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .bind(terms.join(" OR "), limit)
      .all<{ id: string; text: string }>();
    return results ?? [];
  } catch {
    // A malformed MATCH must never take the ask down; worst case we skip the
    // semantic match and the question is stored as new.
    return [];
  }
}

export async function insertQuestion(db: D1Database, row: QuestionRow): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO questions
           (id, text, normalized, noul, verdict, topic, settledness, ask_count, created_at, last_asked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(normalized) DO UPDATE SET
           ask_count = ask_count + 1,
           last_asked_at = excluded.last_asked_at`,
      )
      .bind(
        row.id, row.text, row.normalized, row.noul, row.verdict,
        row.topic, row.settledness, row.created_at, row.last_asked_at,
      ),
    db.prepare("INSERT INTO questions_fts (id, text) VALUES (?, ?)").bind(row.id, row.text),
  ]);
}

export async function recordRepeatAsk(db: D1Database, id: string, at: number): Promise<void> {
  await db
    .prepare("UPDATE questions SET ask_count = ask_count + 1, last_asked_at = ? WHERE id = ?")
    .bind(at, id)
    .run();
}

export async function insertAlias(
  db: D1Database,
  alias: {
    normalized: string;
    questionId: string;
    text: string;
    similarity: number;
    polarity: number;
    at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO question_aliases (normalized, question_id, text, similarity, polarity, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(normalized) DO NOTHING`,
    )
    .bind(
      alias.normalized, alias.questionId, alias.text,
      alias.similarity, alias.polarity, alias.at,
    )
    .run();
}

export async function feed(
  db: D1Database,
  opts: { sort: "recent" | "top"; topic?: string; limit: number },
): Promise<QuestionRow[]> {
  const order =
    opts.sort === "top" ? "ask_count DESC, last_asked_at DESC" : "last_asked_at DESC";
  const where = opts.topic ? "WHERE topic = ?" : "";
  const binds: unknown[] = opts.topic ? [opts.topic, opts.limit] : [opts.limit];

  const { results } = await db
    .prepare(`SELECT * FROM questions ${where} ORDER BY ${order} LIMIT ?`)
    .bind(...binds)
    .all<QuestionRow>();
  return results ?? [];
}

export async function variantsOf(db: D1Database, id: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT text FROM question_aliases WHERE question_id = ? ORDER BY created_at LIMIT 12")
    .bind(id)
    .all<{ text: string }>();
  return (results ?? []).map((r) => r.text);
}

/** Increments and checks the per-IP daily allowance in one round trip. */
export async function consumeDailyQuota(
  db: D1Database,
  ipHash: string,
  day: string,
  quota: number,
): Promise<{ allowed: boolean; used: number; quota: number }> {
  const row = await db
    .prepare(
      `INSERT INTO ip_quota (ip_hash, day, used) VALUES (?, ?, 1)
       ON CONFLICT(ip_hash, day) DO UPDATE SET used = used + 1
       RETURNING used`,
    )
    .bind(ipHash, day)
    .first<{ used: number }>();

  const used = row?.used ?? 1;
  return { allowed: used <= quota, used, quota };
}

/** Quota rows are only meaningful for the current day. */
export async function pruneQuota(db: D1Database, beforeDay: string): Promise<void> {
  await db.prepare("DELETE FROM ip_quota WHERE day < ?").bind(beforeDay).run();
}

export async function stats(db: D1Database) {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM questions) AS questions,
         (SELECT COALESCE(SUM(ask_count), 0) FROM questions) AS asks,
         (SELECT COUNT(*) FROM question_aliases) AS variants`,
    )
    .first<{ questions: number; asks: number; variants: number }>();
}
