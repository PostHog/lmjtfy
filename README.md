# lmjtfy

**Let Me Jev That For You.** A public page where anyone can put a yes/no question
to [Jev](https://docs.typesafe.ai/), TypeSafe's System One model, and get back a
probability instead of an argument.

Jev doesn't generate text. It returns a number between 0 and 1 — the probability
that the answer is yes — so the whole interface is built around a needle on a
scale rather than a chat transcript.

Live at **[lmjtfy.dev](https://lmjtfy.dev)**.

## How it works

An ask runs through up to three stages, each a separate System One request. All
questions within a stage are independent judgments over the same state, so they
run in parallel.

**1. The gate** (`src/jev.ts`, `runGate`) — hidden from the visitor. Six parallel
judgments decide whether the submission is answerable and publishable:

| Question | Type | Blocks when |
| --- | --- | --- |
| `yes_no` | Noul | below 0.55 — not answerable with yes or no |
| `sfw` | Noul | below 0.50 — not safe for a work screen |
| `pg13` | Noul | below 0.50 — beyond a PG-13 rating |
| `injection` | Noul | above 0.60 — instructing the system rather than asking it |
| `targets_individual` | Noul | above 0.70 — a verdict on a private person |
| `severity` | Score | above 1.6 — publishing a verdict could do real harm |

Thresholds live in `GATE_POLICY`, separate from the questions, so the safety
posture can be retuned without touching what Jev is asked.

**2. Grouping** — exact repeats never reach Jev at all. `normalizeQuestion`
strips case, punctuation, diacritics and a "hey Jev" vocative to produce a
grouping key; a hit on that key or on a stored alias returns the existing answer
and bumps `ask_count`.

Rewordings are a judgment, not a string rule. D1's FTS5 index pulls up to six
keyword candidates, then one request asks Jev — one Noul per candidate, in
parallel — whether the new question is the same question in different words. A
match above 0.85 is stored as an alias. The criteria explicitly rule out
opposite polarity, so *is X good* and *is X bad* never merge.

**3. The verdict** (`runVerdict`) — three parallel judgments: a Noul for the
answer itself, a Score for how settled the answer is, and a Choice for the
subject tag. The Noul probability is bucketed into a stance, with a genuine
middle band: a value near 0.5 means yes and no are similarly likely, and the
page says "jev is torn" rather than rounding to a side.

### Prompt injection

Visitor text is only ever placed in `state` and referenced by backticked path.
It is never interpolated into `instructions`. Jev does not treat state as
hostile by default, so the `injection` judgment is a second line rather than
the only one.

## Stack

- **Cloudflare Workers** — API and static asset serving (`src/index.ts`)
- **D1** — questions, aliases, FTS5 index, per-IP quota, rejection counters
- **TypeSafe JS SDK** — `@typesafe-ai/sdk`, which supports the Workers runtime
- No frontend framework. One HTML page, one stylesheet, one module.

### Rate limits

| Limit | Scope | Enforced by |
| --- | --- | --- |
| 4 asks / 10s | per IP | Workers rate limiting binding |
| 20 asks / 60s | per IP | Workers rate limiting binding |
| 30 feed reads / 10s | per IP | Workers rate limiting binding |
| 60 Jev-reaching asks / UTC day | per IP | D1 (`ip_quota`) |

The daily quota is only charged when an ask actually reaches Jev. Reading an
answer someone else already paid for is free.

IPs are never stored in the clear — only a salted SHA-256 hash, in rows pruned
after three days. Blocked submissions are counted by reason; their text is not
retained.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in TYPESAFE_API_KEY and IP_SALT
npm run db:migrate:local
npm run dev
```

```bash
npm test          # normalization and verdict bucketing
npm run typecheck
```

## Deploying

```bash
npm run db:migrate                      # apply migrations to the remote D1
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put IP_SALT         # any long random string
npm run deploy
```

`wrangler.jsonc` binds `lmjtfy.dev` and `www.lmjtfy.dev` as custom domains.

## Layout

```
src/
  index.ts       router, SSE ask flow, asset serving
  jev.ts         every System One question, thresholds, verdict bucketing
  db.ts          D1 queries
  normalize.ts   grouping key, ids, IP hashing
  ratelimit.ts   per-IP limits
  sse.ts         event stream writer
public/          index.html, styles.css, app.js
migrations/      D1 schema
test/            unit tests
```
