import type { Env } from "./types";

export interface LimitOutcome {
  ok: boolean;
  /** Which limit tripped, for the message shown to the visitor. */
  scope?: "burst" | "sustained" | "daily";
  retryAfter?: number;
}

/**
 * Two native rate-limit bindings guard request rate per IP; the daily quota in
 * D1 is charged separately and only when an ask actually reaches Jev, so
 * re-reading answers other people already paid for stays free.
 */
export async function checkAskRate(env: Env, ipHash: string): Promise<LimitOutcome> {
  const burst = await env.RL_BURST?.limit({ key: ipHash });
  if (burst && !burst.success) return { ok: false, scope: "burst", retryAfter: 10 };

  const sustained = await env.RL_SUSTAINED?.limit({ key: ipHash });
  if (sustained && !sustained.success) return { ok: false, scope: "sustained", retryAfter: 60 };

  return { ok: true };
}

export async function checkFeedRate(env: Env, ipHash: string): Promise<LimitOutcome> {
  const feed = await env.RL_FEED?.limit({ key: ipHash });
  if (feed && !feed.success) return { ok: false, scope: "burst", retryAfter: 10 };
  return { ok: true };
}

export function limitMessage(outcome: LimitOutcome): string {
  switch (outcome.scope) {
    case "burst":
      return "Jev needs a breath. Try again in a few seconds.";
    case "sustained":
      return "That is a lot of questions in one minute. Give it a minute.";
    case "daily":
      return "You have used up today's questions. Jev will be here tomorrow.";
    default:
      return "Slow down a moment.";
  }
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "0.0.0.0"
  );
}

export function utcDay(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}
