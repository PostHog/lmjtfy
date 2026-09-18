import * as db from "./db";
import { findSameQuestion, jevClient, runGate, runVerdict, verdictLabel } from "./jev";
import { hashIp, normalizeQuestion, questionId, tidyDisplay } from "./normalize";
import { checkAskRate, checkFeedRate, clientIp, limitMessage, utcDay } from "./ratelimit";
import { EventStream } from "./sse";
import type { Env, MatchKind, QuestionRow } from "./types";

const MIN_LEN = 3;
const MAX_LEN = 280;

const GATE_MESSAGES: Record<string, string> = {
  not_yes_no: "Jev only does yes and no. Rephrase it so yes or no is an answer.",
  not_sfw: "Jev keeps it work-safe. Ask something else.",
  not_pg13: "Jev keeps it PG-13. Ask something else.",
  injection: "Nice try. Ask Jev a question instead of giving it orders.",
  private_individual: "Jev does not hand down verdicts on private individuals.",
  harmful: "Jev is not going to put a yes or no on that one.",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (err) {
        console.error("api error", err);
        return json({ error: "Something went wrong on our side." }, 500);
      }
    }

    return serveAsset(request, env, url);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const ipHash = await hashIp(clientIp(request), env.IP_SALT ?? "lmjtfy");

  if (url.pathname === "/api/ask" && request.method === "POST") {
    return handleAsk(request, env, ctx, ipHash);
  }

  if (url.pathname === "/api/feed" && request.method === "GET") {
    const gate = await checkFeedRate(env, ipHash);
    if (!gate.ok) return json({ error: limitMessage(gate) }, 429);

    const sort = url.searchParams.get("sort") === "top" ? "top" : "recent";
    const topic = url.searchParams.get("topic") ?? undefined;
    const limit = clampInt(url.searchParams.get("limit"), 30, 1, 60);
    const rows = await db.feed(env.DB, { sort, topic, limit });
    return json({ questions: rows.map(present) }, 200, { "cache-control": "public, max-age=3" });
  }

  const questionMatch = url.pathname.match(/^\/api\/question\/([a-f0-9]{32})$/);
  if (questionMatch && request.method === "GET") {
    const id = questionMatch[1]!;
    const row = await db.findById(env.DB, id);
    if (!row) return json({ error: "No such question." }, 404);
    return json({ question: present(row), variants: await db.variantsOf(env.DB, id) });
  }

  if (url.pathname === "/api/stats" && request.method === "GET") {
    return json(await db.stats(env.DB), 200, { "cache-control": "public, max-age=30" });
  }

  return json({ error: "Not found." }, 404);
}

async function handleAsk(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  ipHash: string,
): Promise<Response> {
  const rate = await checkAskRate(env, ipHash);
  if (!rate.ok) {
    return json({ error: limitMessage(rate) }, 429, {
      "retry-after": String(rate.retryAfter ?? 10),
    });
  }

  let body: { question?: unknown };
  try {
    body = (await request.json()) as { question?: unknown };
  } catch {
    return json({ error: "Send JSON with a question." }, 400);
  }

  const raw = typeof body.question === "string" ? tidyDisplay(body.question) : "";
  if (raw.length < MIN_LEN) return json({ error: "That is a bit short for a question." }, 400);
  if (raw.length > MAX_LEN) {
    return json({ error: `Keep it under ${MAX_LEN} characters.` }, 400);
  }

  const normalized = normalizeQuestion(raw);
  if (normalized.length < MIN_LEN) {
    return json({ error: "Jev needs actual words to work with." }, 400);
  }

  const stream = new EventStream();
  ctx.waitUntil(runAsk({ env, ctx, stream, raw, normalized, ipHash }));
  return stream.response();
}

interface AskContext {
  env: Env;
  ctx: ExecutionContext;
  stream: EventStream;
  raw: string;
  normalized: string;
  ipHash: string;
}

async function runAsk({ env, ctx, stream, raw, normalized, ipHash }: AskContext): Promise<void> {
  const now = Date.now();
  const day = utcDay(now);

  try {
    // Exact repeats never reach Jev — same question, same answer, higher count.
    const exact =
      (await db.findByNormalized(env.DB, normalized)) ??
      (await db.findByAlias(env.DB, normalized));

    if (exact) {
      await db.recordRepeatAsk(env.DB, exact.id, now);
      stream.send("answer", {
        question: present({ ...exact, ask_count: exact.ask_count + 1, last_asked_at: now }),
        match: (exact.normalized === normalized ? "exact" : "alias") satisfies MatchKind,
      });
      stream.close();
      return;
    }

    // Only work that actually costs a Jev call is charged to the daily quota.
    const quota = await db.consumeDailyQuota(
      env.DB,
      ipHash,
      day,
      clampInt(env.DAILY_ASK_QUOTA, 60, 1, 10_000),
    );
    if (!quota.allowed) {
      stream.send("blocked", {
        reason: "rate_limited",
        message: limitMessage({ ok: false, scope: "daily" }),
      });
      stream.close();
      return;
    }

    if (Math.random() < 0.02) {
      ctx.waitUntil(db.pruneQuota(env.DB, utcDay(now - 3 * 86_400_000)));
    }

    const client = jevClient(env);

    stream.send("stage", { stage: "reading" });

    // The gate and the candidate shortlist do not depend on each other, so
    // they overlap. Candidate retrieval is a D1 read, paid for either way.
    const candidatesPromise = db.findCandidates(env.DB, normalized).catch(() => []);
    const gate = await runGate(client, raw);

    if (!gate.ok) {
      ctx.waitUntil(db.recordRejection(env.DB, day, gate.reason ?? "unknown"));
      stream.send("blocked", {
        reason: gate.reason,
        message: GATE_MESSAGES[gate.reason ?? ""] ?? "Jev will not answer that one.",
      });
      stream.close();
      return;
    }

    stream.send("stage", { stage: "matching" });

    const candidates = await candidatesPromise;
    if (candidates.length > 0) {
      const same = await findSameQuestion(client, raw, candidates).catch(() => null);
      if (same) {
        const existing = await db.findById(env.DB, same.id);
        if (existing) {
          await db.insertAlias(env.DB, {
            normalized,
            questionId: existing.id,
            text: raw,
            similarity: same.similarity,
            at: now,
          });
          await db.recordRepeatAsk(env.DB, existing.id, now);
          stream.send("answer", {
            question: present({
              ...existing,
              ask_count: existing.ask_count + 1,
              last_asked_at: now,
            }),
            match: "semantic" satisfies MatchKind,
            askedAs: raw,
            similarity: same.similarity,
          });
          stream.close();
          return;
        }
      }
    }

    stream.send("stage", { stage: "asking" });

    const verdict = await runVerdict(client, raw);
    const id = await questionId(normalized);
    const row: QuestionRow = {
      id,
      text: raw,
      normalized,
      noul: verdict.noul,
      verdict: verdict.verdict,
      topic: verdict.topic,
      settledness: verdict.settledness,
      ask_count: 1,
      created_at: now,
      last_asked_at: now,
    };

    await db.insertQuestion(env.DB, row);
    stream.send("answer", { question: present(row), match: "new" satisfies MatchKind });
  } catch (err) {
    console.error("ask failed", err);
    stream.send("error", { message: "Jev could not be reached. Try again in a moment." });
  } finally {
    stream.close();
  }
}

/** Shape sent to the browser. Normalization keys stay server-side. */
function present(row: QuestionRow) {
  return {
    id: row.id,
    text: row.text,
    noul: Number(row.noul.toFixed(4)),
    verdict: row.verdict || verdictLabel(row.noul),
    topic: row.topic,
    settledness: Number(row.settledness.toFixed(2)),
    askCount: row.ask_count,
    createdAt: row.created_at,
    lastAskedAt: row.last_asked_at,
  };
}

async function serveAsset(request: Request, env: Env, url: URL): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  const response =
    asset.status === 404 && !url.pathname.includes(".")
      ? await env.ASSETS.fetch(new Request(new URL("/", url), request))
      : asset;

  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  return new Response(response.body, { status: response.status, headers });
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function clampInt(value: string | null | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
