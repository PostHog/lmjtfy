import * as db from "./db";
import { findSameQuestion, jevClient, runGate, runVerdict, verdictLabel } from "./jev";
import { hashIp, normalizeQuestion, questionId, tidyDisplay } from "./normalize";
import type { Notice } from "./ratelimit";
import { checkAskRate, checkFeedRate, clientIp, limitNotice, utcDay } from "./ratelimit";
import { RateLimitError, APIConnectionError } from "@typesafe-ai/sdk";
import { blockedResponse, isBlockedAgent } from "./bots";
import { decorateHtml, sitemapXml } from "./seo";
import { EventStream } from "./sse";
import type { Env, MatchKind, QuestionRow } from "./types";

export { ReadingsHub } from "./hub";

const MIN_LEN = 3;
const MAX_LEN = 280;

const GATE_NOTICES: Record<string, Notice> = {
  not_yes_no: {
    kind: "refusal",
    title: "Not a yes or no question",
    body: "Jev only answers questions where yes or no is the answer. Rephrase it and try again.",
  },
  not_sfw: {
    kind: "refusal",
    title: "Not work-safe",
    body: "Jev keeps this page safe to have open at work. Ask something else.",
  },
  not_pg13: {
    kind: "refusal",
    title: "Past PG-13",
    body: "Jev keeps this page PG-13. Ask something else.",
  },
  injection: {
    kind: "refusal",
    title: "Nice try",
    body: "Ask Jev a question rather than giving it instructions.",
  },
  private_individual: {
    kind: "refusal",
    title: "Not about people",
    body: "Jev does not hand down verdicts on people, famous or otherwise, or on their names. Ask about something instead of someone.",
  },
  harmful: {
    kind: "refusal",
    title: "Jev passes on this one",
    body: "A yes or no here could do real damage, so Jev is not going to give one.",
  },
};

const UNKNOWN_REFUSAL: Notice = {
  kind: "refusal",
  title: "Jev passes on this one",
  body: "Jev will not put a yes or no on that question.",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // lmjtfy.dev is the canonical host; www only exists to point at it.
    if (url.hostname.startsWith("www.")) {
      const canonical = new URL(url);
      canonical.hostname = url.hostname.slice(4);
      return Response.redirect(canonical.toString(), 301);
    }

    // robots.txt stays readable so a refused crawler can see the policy.
    if (url.pathname !== "/robots.txt" && isBlockedAgent(request.headers.get("user-agent"))) {
      return blockedResponse();
    }

    if (url.pathname === "/sitemap.xml") {
      const rows = await db.feed(env.DB, { sort: "top", limit: 500 }).catch(() => []);
      return new Response(sitemapXml(rows), {
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "public, max-age=1800",
        },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (err) {
        console.error("api error", err);
        return json(
          {
            kind: "error",
            title: "Something broke",
            body: "That is on us, not on your question. Try again in a moment.",
          } satisfies Notice,
          500,
        );
      }
    }

    return serveAsset(request, env, url);
  },
} satisfies ExportedHandler<Env>;

function hub(env: Env): DurableObjectStub {
  return env.HUB.get(env.HUB.idFromName("global"));
}

/** Pushes a reading to everyone with the page open. Never blocks the answer. */
async function publish(env: Env, reading: unknown): Promise<void> {
  try {
    await hub(env).fetch("https://hub/publish", {
      method: "POST",
      body: JSON.stringify(reading),
    });
  } catch (err) {
    console.error("publish failed", err);
  }
}

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

  if (url.pathname === "/api/stream" && request.method === "GET") {
    return hub(env).fetch("https://hub/subscribe");
  }

  if (url.pathname === "/api/feed" && request.method === "GET") {
    const gate = await checkFeedRate(env, ipHash);
    if (!gate.ok) return json(limitNotice(gate), 429);

    const sort = url.searchParams.get("sort") === "top" ? "top" : "recent";
    const topic = url.searchParams.get("topic") ?? undefined;
    const limit = clampInt(url.searchParams.get("limit"), 30, 1, 60);
    const rows = await db.feed(env.DB, { sort, topic, limit });
    return json({ questions: rows.map((row) => present(row)) }, 200, { "cache-control": "public, max-age=3" });
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

  return json({ kind: "error", title: "Not found", body: "No such endpoint." } satisfies Notice, 404);
}

async function handleAsk(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  ipHash: string,
): Promise<Response> {
  const rate = await checkAskRate(env, ipHash);
  if (!rate.ok) {
    return json(limitNotice(rate), 429, { "retry-after": String(rate.retryAfter ?? 10) });
  }

  let body: { question?: unknown };
  try {
    body = (await request.json()) as { question?: unknown };
  } catch {
    return json({ kind: "error", title: "Malformed request", body: "Send JSON with a question field." } satisfies Notice, 400);
  }

  const raw = typeof body.question === "string" ? tidyDisplay(body.question) : "";
  if (raw.length < MIN_LEN) return json({ kind: "refusal", title: "Too short", body: "That is not quite a question yet." } satisfies Notice, 400);
  if (raw.length > MAX_LEN) {
    return json({ kind: "refusal", title: "Too long", body: `Keep it under ${MAX_LEN} characters. Jev answers questions, not essays.` } satisfies Notice, 400);
  }

  const normalized = normalizeQuestion(raw);
  if (normalized.length < MIN_LEN) {
    return json({ kind: "refusal", title: "No words in there", body: "Jev needs actual words to work with." } satisfies Notice, 400);
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
    const direct = await db.findByNormalized(env.DB, normalized);
    const aliased = direct ? null : await db.findByAlias(env.DB, normalized);
    const exact = direct ?? aliased;

    if (exact) {
      await db.recordRepeatAsk(env.DB, exact.id, now);
      const bumped = { ...exact, ask_count: exact.ask_count + 1, last_asked_at: now };
      const polarity: 1 | -1 = aliased?.polarity === -1 ? -1 : 1;
      stream.send("answer", {
        question: present(bumped, polarity, raw),
        reading: present(bumped),
        match: (direct ? "exact" : "alias") satisfies MatchKind,
      });
      ctx.waitUntil(publish(env, present(bumped)));
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
      stream.send("notice", limitNotice({ ok: false, scope: "daily" }, quota.quota));
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
      stream.send("notice", GATE_NOTICES[gate.reason ?? ""] ?? UNKNOWN_REFUSAL);
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
            polarity: same.polarity,
            at: now,
          });
          await db.recordRepeatAsk(env.DB, existing.id, now);
          const bumped = {
            ...existing,
            ask_count: existing.ask_count + 1,
            last_asked_at: now,
          };
          stream.send("answer", {
            question: present(bumped, same.polarity, raw),
            reading: present(bumped),
            match: "semantic" satisfies MatchKind,
            askedAs: raw,
            similarity: same.similarity,
          });
          ctx.waitUntil(publish(env, present(bumped)));
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
    stream.send("answer", {
      question: present(row),
      reading: present(row),
      match: "new" satisfies MatchKind,
    });
    ctx.waitUntil(publish(env, present(row)));
  } catch (err) {
    console.error("ask failed", err);
    stream.send("notice", upstreamNotice(err));
  } finally {
    stream.close();
  }
}

/** Tells the visitor whether Jev is oversubscribed or genuinely broken. */
function upstreamNotice(err: unknown): Notice {
  if (err instanceof RateLimitError) {
    return {
      kind: "limit",
      title: "Jev is oversubscribed",
      body: "Too many people are asking at once. Give it a few seconds and ask again.",
    };
  }
  if (err instanceof APIConnectionError) {
    return {
      kind: "error",
      title: "Could not reach Jev",
      body: "The request timed out on the way. Try again in a moment.",
    };
  }
  return {
    kind: "error",
    title: "Something broke",
    body: "That is on us, not on your question. Try again in a moment.",
  };
}

/**
 * Shape sent to the browser. Normalization keys stay server-side.
 *
 * `polarity` of -1 means the visitor asked the inverse of the stored question,
 * so they get their own wording and the flipped probability. The bucket labels
 * are symmetric about 0.5, so the flipped verdict is the exact mirror.
 */
function present(row: QuestionRow, polarity: 1 | -1 = 1, asText?: string) {
  const noul = polarity === -1 ? 1 - row.noul : row.noul;
  return {
    id: row.id,
    text: polarity === -1 && asText ? asText : row.text,
    noul: Number(noul.toFixed(4)),
    verdict: polarity === -1 ? verdictLabel(noul) : row.verdict || verdictLabel(row.noul),
    topic: row.topic,
    settledness: Number(row.settledness.toFixed(2)),
    inverted: polarity === -1,
    askCount: row.ask_count,
    createdAt: row.created_at,
    lastAskedAt: row.last_asked_at,
  };
}

async function serveAsset(request: Request, env: Env, url: URL): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  let response =
    asset.status === 404 && !url.pathname.includes(".")
      ? await env.ASSETS.fetch(new Request(new URL("/", url), request))
      : asset;

  if (response.headers.get("content-type")?.includes("text/html")) {
    response = await decorate(request, env, url, response);
  }

  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set(
    "content-security-policy",
    [
      "default-src 'self'",
      "img-src 'self' data:",
      // Positions on the gauge and the reading dots are inline custom
      // properties; without this CSP collapses every one of them to zero.
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' https://static.cloudflareinsights.com https://internal-c.posthog.com",
      "connect-src 'self' https://cloudflareinsights.com https://internal-c.posthog.com",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
  );
  return new Response(response.body, { status: response.status, headers });
}

/** Bakes the live readings, and any ?q= question, into the served HTML. */
async function decorate(
  request: Request,
  env: Env,
  url: URL,
  response: Response,
): Promise<Response> {
  const rows = await db.feed(env.DB, { sort: "recent", limit: 30 }).catch(() => []);

  const q = url.searchParams.get("q");
  let focus: QuestionRow | undefined;
  let focusQuery: string | undefined;

  if (q) {
    focusQuery = tidyDisplay(q).slice(0, MAX_LEN);
    const normalized = normalizeQuestion(focusQuery);
    const found =
      (await db.findByNormalized(env.DB, normalized).catch(() => null)) ??
      (await db.findByAlias(env.DB, normalized).catch(() => null));
    focus = found ?? undefined;
  }

  return decorateHtml(response, { rows, focus, focusQuery });
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
