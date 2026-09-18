import type { QuestionRow } from "./types";
import { verdictLabel } from "./jev";

/**
 * The page renders its readings client-side, so a crawler would otherwise see
 * an empty column and a page with no content. These helpers inject the current
 * readings into the HTML before it leaves the Worker, which also makes the
 * FAQPage markup honest: every question in the structured data is really in
 * the document.
 */

const SITE = "https://lmjtfy.dev";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readingColour(p: number): string {
  if (p > 0.58) return "var(--yes)";
  if (p < 0.42) return "var(--no)";
  return "var(--torn)";
}

/** Mirrors readingNode() in app.js so the client can take over seamlessly. */
export function readingsHtml(rows: QuestionRow[]): string {
  return rows
    .map((row) => {
      const verdict = escapeHtml((row.verdict || verdictLabel(row.noul)).toLowerCase());
      return (
        `<li class="reading" data-id="${row.id}" style="--reading:${readingColour(row.noul)}">` +
        `<p class="reading__text">${escapeHtml(row.text)}</p>` +
        `<div class="reading__bar"><span class="reading__dot" style="--p:${row.noul.toFixed(4)}"></span></div>` +
        `<div class="reading__line">` +
        `<span class="reading__verdict">${verdict}</span>` +
        `<span class="reading__prob">${row.noul.toFixed(2)}</span>` +
        `<span class="reading__count">${row.ask_count}×</span>` +
        `</div></li>`
      );
    })
    .join("");
}

/** "Jev is torn" already names Jev, so it does not want "Jev says" in front. */
function headline(row: QuestionRow): string {
  const verdict = row.verdict || verdictLabel(row.noul);
  return verdict.toLowerCase().startsWith("jev") ? verdict : `Jev says ${verdict.toLowerCase()}`;
}

function answerSentence(row: QuestionRow): string {
  const percent = Math.round(row.noul * 100);
  const times = `Asked ${row.ask_count} time${row.ask_count === 1 ? "" : "s"}.`;
  return `${headline(row)}. The odds of yes are ${row.noul.toFixed(2)}, or ${percent}%. ${times}`;
}

/** FAQPage over the questions actually present in the document. */
export function faqJsonLd(rows: QuestionRow[]): string {
  if (rows.length === 0) return "";
  const payload = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${SITE}/#faq`,
    mainEntity: rows.slice(0, 20).map((row) => ({
      "@type": "Question",
      name: row.text,
      url: `${SITE}/?q=${encodeURIComponent(row.text)}`,
      acceptedAnswer: { "@type": "Answer", text: answerSentence(row) },
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`;
}

export interface Decoration {
  rows: QuestionRow[];
  /** Present when the visitor followed a ?q= link to a question Jev has answered. */
  focus?: QuestionRow;
  focusQuery?: string;
}

export function decorateHtml(response: Response, decoration: Decoration): Response {
  const { rows, focus, focusQuery } = decoration;

  const title = focus ? `${focus.text} ${headline(focus)}.` : "lmjtfy: let me Jev that for you";
  const description = focus
    ? answerSentence(focus)
    : "Ask Jev anything, as long as the answer is yes or no.";
  const canonical = focusQuery ? `${SITE}/?q=${encodeURIComponent(focusQuery)}` : `${SITE}/`;

  const setContent = (value: string) => ({
    element(element: Element) {
      element.setAttribute("content", value);
    },
  });

  return new HTMLRewriter()
    .on("title", {
      element(element) {
        element.setInnerContent(title);
      },
    })
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:url"]', setContent(canonical))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(description))
    .on('link[rel="canonical"]', {
      element(element) {
        element.setAttribute("href", canonical);
      },
    })
    .on("#ledger-list", {
      element(element) {
        if (rows.length > 0) element.setInnerContent(readingsHtml(rows), { html: true });
      },
    })
    .onDocument({
      comments(comment) {
        if (comment.text.includes("faq-ld")) {
          comment.replace(faqJsonLd(rows), { html: true });
        }
      },
    })
    .transform(response);
}

/** One entry per question Jev has answered, so the long tail is indexable. */
export function sitemapXml(rows: QuestionRow[]): string {
  const urls = [
    `  <url><loc>${SITE}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    ...rows.map((row) => {
      const loc = escapeHtml(`${SITE}/?q=${encodeURIComponent(row.text)}`);
      const lastmod = new Date(row.last_asked_at).toISOString().slice(0, 10);
      return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`;
    }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
