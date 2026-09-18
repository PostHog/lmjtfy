/**
 * robots.txt is advisory. These agents are refused at the edge as well, so the
 * policy in public/robots.txt is actually enforced for anything that sends an
 * honest user agent.
 *
 * Matching is on lowercased substrings, and every entry is specific enough not
 * to catch an allowed agent. Note `applebot-extended` rather than `applebot`:
 * Apple's search crawler stays welcome, its training crawler does not.
 */
const BLOCKED_AGENTS = [
  // OpenAI
  "gptbot", "oai-searchbot", "chatgpt-user",
  // Anthropic
  "claudebot", "claude-user", "claude-searchbot", "claude-web", "anthropic-ai",
  // Perplexity
  "perplexitybot", "perplexity-user",
  // Platform training opt-outs
  "google-extended", "applebot-extended", "webzio-extended",
  // Meta
  "meta-externalagent", "meta-externalfetcher", "facebookbot",
  // Others that crawl for training or answer generation
  "amazonbot", "bytespider", "ccbot", "cohere-ai", "cohere-training-data-crawler",
  "diffbot", "omgili", "imagesiftbot", "youbot", "ai2bot", "timpibot",
  "pangubot", "kangaroo bot", "duckassistbot", "mistralai-user", "semrushbot-ocob",
];

export function isBlockedAgent(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BLOCKED_AGENTS.some((agent) => ua.includes(agent));
}

/** Refused agents still get robots.txt, so the policy is discoverable. */
export function blockedResponse(): Response {
  return new Response(
    "lmjtfy.dev does not permit crawling for model training or answer generation.\n" +
      "See https://lmjtfy.dev/robots.txt\n",
    {
      status: 403,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noai, noimageai",
      },
    },
  );
}
