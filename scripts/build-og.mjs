/**
 * Renders the social preview image and the Apple touch icon.
 *
 * Drives the Chrome already installed on the machine through playwright-core,
 * which downloads no browser of its own. Chrome's own --screenshot flag writes
 * the file and then frequently fails to exit, which makes it useless in a
 * script that renders more than one image.
 *
 * Re-run with `npm run build:og` after editing scripts/og.html or icon.html.
 */
import { chromium } from "playwright-core";

const jobs = [
  { from: "og.html", out: "og.png", width: 1200, height: 630 },
  { from: "icon.html", out: "apple-touch-icon.png", width: 180, height: 180 },
];

const browser = await chromium.launch({ channel: "chrome" });

try {
  for (const { from, out, width, height } of jobs) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(new URL(`./${from}`, import.meta.url).href, { waitUntil: "load" });
    await page.screenshot({ path: new URL(`../public/${out}`, import.meta.url).pathname });
    await page.close();
    console.log(`public/${out} — ${width}x${height}`);
  }
} finally {
  await browser.close();
}
