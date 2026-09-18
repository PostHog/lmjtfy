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

**1. The gate** (`src/jev.ts`, `runGate`) — hidden from the visitor. Nine parallel
judgments decide whether the submission is answerable and publishable:

| Question | Type | Blocks when |
| --- | --- | --- |
| `english` | Noul | below 0.60 — not written in English |
| `yes_no` | Noul | below 0.55 — not answerable with yes or no, including "A or B" pick-one questions |
| `sfw` | Noul | below 0.50 — not safe for a work screen |
| `pg13` | Noul | below 0.50 — beyond a PG-13 rating |
| `injection` | Noul | above 0.60 — instructing the system rather than asking it |
| `market` | Noul | above 0.60 — would read as investment advice or move a price |
| `about_person` + `famous_person` | Noul | a person is judged (above 0.60) *and* is not unmistakably one public figure (below 0.60) |
| `severity` | Score | above 1.6 — publishing a verdict could do real harm |

English is checked first, because telling someone writing in Spanish that their
question is not a yes/no question helps nobody. Jev's accuracy is highest in
English, so a verdict on anything else would be less trustworthy than it looks.
Loanwords and foreign names do not count against it: "is jamon iberico
overrated" scores 0.99 while a full Spanish sentence scores 0.01.

The two person questions are deliberately separate and composed in code, because
fame is not the test: identifiability is. "Musk" points at one man and is
allowed; "Elon" could be anybody and is not, even though a famous person shares
the name. Measured across 20 cases, allowed names score 0.87 and up on
`famous_person` while bare first names sit at 0.12 and below.

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
- **D1** — questions, aliases, FTS5 index, per-IP quota
- **Durable Object** — one `ReadingsHub` fans new readings out to every open page
- **TypeSafe JS SDK** — `@typesafe-ai/sdk`, which supports the Workers runtime
- No frontend framework and no build step. One HTML page, one stylesheet, one
  ES module, served verbatim — 24.5 KB raw, 7.6 KB gzipped.

The one generated asset is the PostHog logo in the footer: `@posthog/brand`
ships React components, so `npm run build:logo` inlines the raw geometry into
`public/index.html` instead. It is inlined rather than an `<img>` because the
mono variant paints with `currentColor`, which does not inherit across an
`<img>` boundary.

### Live readings

The ledger is pushed, not polled. Each answer is published to a single
`ReadingsHub` Durable Object, which broadcasts it over SSE to everyone with the
page open, so ask counts tick up on other people's screens as they happen.

That single object is a deliberate hotspot. Subscribers are capped at 4,000 and
the hub returns 503 past that; the page also keeps a slow poll running and falls
back to it whenever the stream drops or is refused. A spike degrades to the old
behaviour rather than taking the column down.

### Rate limits

| Limit | Scope | Enforced by |
| --- | --- | --- |
| 4 asks / 10s | per IP | Workers rate limiting binding |
| 20 asks / 60s | per IP | Workers rate limiting binding |
| 30 feed reads / 10s | per IP | Workers rate limiting binding |
| 500 Jev-reaching asks / UTC day | per IP | D1 (`ip_quota`) |

The daily quota is only charged when an ask actually reaches Jev. Reading an
answer someone else already paid for is free.

The daily cap is deliberately generous, because it was never the thing holding
costs down. A new question costs about 1,900 input tokens across both requests
— roughly $0.00008, so a million of them is under $80. The real ceiling is
TypeSafe's account limit of 1,200 requests per minute, which a traffic spike
reaches long before any per-IP cap matters. When it does, the SDK's `RateLimitError`
surfaces as a "Jev is oversubscribed" notice rather than a generic failure.

The page distinguishes three reasons an answer might not arrive, because they
are not the same event and should not look alike: a **refusal** (Jev declined
the question), a **limit** (an allowance ran out), and an **error** (our fault).

IPs are never stored in the clear, only a salted SHA-256 hash, in rows pruned
after three days. Blocked submissions are not stored at all: the `question
refused` event in PostHog records the reason, and nothing about a refused
question reaches the database.

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
`lmjtfy.dev` is canonical; `www` is bound only so the Worker can 301 it to the
apex, preserving path and query.

## Search, answer engines, and crawlers

Search engines and link unfurlers are welcome; crawlers that harvest pages for
model training or answer generation are not. That policy is enforced in three
places, because `robots.txt` alone is only advice:

1. **`public/robots.txt`** — the declared policy, for crawlers that read it.
2. **`src/bots.ts`** — the Worker refuses the same agents with a 403, so the
   policy binds anything that sends an honest user agent. `robots.txt` itself
   stays readable to blocked agents, so the policy is discoverable.
3. **Cloudflare AI Crawl Control** — zone-level enforcement for agents that lie
   about who they are. Configured on the zone, not in this repo:
   *Dashboard → lmjtfy.dev → Security → Settings → AI Crawl Control.*

Matching is on lowercased substrings, and the list is written to avoid catching
an allowed agent by accident: `applebot-extended` rather than `applebot`, so
Apple's search crawler stays welcome while its training crawler does not.

Note the deliberate cost: blocking `OAI-SearchBot`, `Perplexity-User` and
`Claude-SearchBot` keeps the page out of AI answer engines as well as out of
training sets. Those three are the AEO surface. Remove them from
`BLOCKED_AGENTS` and from `robots.txt` if that trade stops being worth it.

### What a crawler actually sees

The readings are rendered client-side, so a crawler would otherwise get an
empty page. `src/seo.ts` uses `HTMLRewriter` to bake the current readings into
the HTML before it leaves the Worker, which also makes the `FAQPage` structured
data honest — every question in the markup is really in the document.

A `?q=` link additionally gets its own `<title>`, description, canonical and
Open Graph tags built from that question's verdict, so each shared question is
its own indexable page. `/sitemap.xml` is generated from D1 and lists them.

## Sharing a question

`lmjtfy.dev/?q=Is+a+hot+dog+a+sandwich%3F` types the question into the input
and asks it, so a shared link replays what the sender saw. Answering a question
rewrites the URL to its own `?q=` form, which makes every reading shareable.
`prefers-reduced-motion` skips the typing and fills the field directly.

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
