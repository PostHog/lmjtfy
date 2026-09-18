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

/** A notice the page can render without deciding how to word it. */
export interface Notice {
  kind: "refusal" | "limit" | "error";
  title: string;
  body: string;
}

export function limitNotice(outcome: LimitOutcome, quota?: number): Notice {
  switch (outcome.scope) {
    case "burst":
      return {
        kind: "limit",
        title: "One at a time",
        body: "Jev is still catching up on your last question. Try again in a few seconds.",
      };
    case "sustained":
      return {
        kind: "limit",
        title: "Slow down",
        body: "That is a lot of questions in one minute. Give it a minute and carry on.",
      };
    case "daily":
      return {
        kind: "limit",
        title: "That is today's lot",
        body: `You have used all ${quota ?? "of today's"} questions for today. The counter resets at midnight UTC, in ${untilUtcMidnight()}. Everything already asked is still in the readings.`,
      };
    default:
      return { kind: "limit", title: "Hold on", body: "Give it a moment and try again." };
  }
}

/** Human-readable time until the daily quota rolls over. */
export function untilUtcMidnight(at = Date.now()): string {
  const next = Date.UTC(
    new Date(at).getUTCFullYear(),
    new Date(at).getUTCMonth(),
    new Date(at).getUTCDate() + 1,
  );
  const minutes = Math.max(1, Math.round((next - at) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
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
