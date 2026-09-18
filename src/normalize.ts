/**
 * Exact-match grouping key. Two submissions that normalize to the same string
 * are the same question by definition and never reach Jev twice.
 *
 * Deliberately conservative: it strips only the things that carry no meaning
 * (case, punctuation, spacing, a "hey Jev" vocative). Anything subtler —
 * "is X good" vs "does X rock" — is left to Jev's semantic match, which can
 * tell those apart from near-misses like "is X bad".
 */
export function normalizeQuestion(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/^\s*(?:hey|hi|hello|ok|okay|yo|so)[\s,]+/u, "")
    .replace(/^\s*jev[\s,:;-]+/u, "")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Stable short id for a normalized question. */
export async function questionId(normalized: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** Collapse whitespace for display without altering wording. */
export function tidyDisplay(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}

/** Salted hash of a client IP. The raw address is never stored. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
