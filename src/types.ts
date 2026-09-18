export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  HUB: DurableObjectNamespace;
  TYPESAFE_API_KEY: string;
  IP_SALT: string;
  DAILY_ASK_QUOTA?: string;
  /** Present when deployed; absent in some local configurations. */
  RL_BURST?: RateLimiter;
  RL_SUSTAINED?: RateLimiter;
  RL_FEED?: RateLimiter;
}

export interface QuestionRow {
  id: string;
  text: string;
  normalized: string;
  noul: number;
  verdict: string;
  topic: string;
  settledness: number;
  ask_count: number;
  created_at: number;
  last_asked_at: number;
}

export type MatchKind = "new" | "exact" | "alias" | "semantic";
