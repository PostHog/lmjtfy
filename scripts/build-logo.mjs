/**
 * Inlines the PostHog landscape logo from @posthog/brand into the footer.
 *
 * The package ships React components and this project has no React, so the raw
 * geometry is written into index.html between markers. Inlined rather than
 * referenced as <img> because the mono variant paints with `currentColor`,
 * which does not inherit across an <img> boundary.
 *
 * Re-run with `npm run build:logo` after upgrading @posthog/brand.
 */
import { readFileSync, writeFileSync } from "node:fs";

// Resolved by path rather than by package specifier: the `./logo` export
// re-exports the React components, and geometry.mjs is not exported on its own.
const { LOGO_BODY, LOGO_VIEW_BOX } = await import(
  new URL("../node_modules/@posthog/brand/dist/logo/geometry.mjs", import.meta.url).href
);

const FORM = "landscape";
const VARIANT = "mono";
const START = "<!-- posthog-logo -->";
const END = "<!-- /posthog-logo -->";

const svg =
  `<svg class="colophon__logo" viewBox="${LOGO_VIEW_BOX[FORM]}" ` +
  `xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true" focusable="false">` +
  `${LOGO_BODY[FORM][VARIANT]}</svg>`;

const path = new URL("../public/index.html", import.meta.url);
const html = readFileSync(path, "utf8");

const from = html.indexOf(START);
const to = html.indexOf(END);
if (from === -1 || to === -1) {
  throw new Error(`index.html is missing the ${START} ... ${END} markers`);
}

writeFileSync(path, html.slice(0, from + START.length) + svg + html.slice(to));
console.log(`index.html — inlined ${FORM}/${VARIANT} logo, ${svg.length} bytes`);
