#!/usr/bin/env node
/**
 * render-cards.mjs — render every assets/*.html to a 1920×1080 PNG.
 *
 * Used for the end card (appended by stitch via END_IMAGE) and for any
 * "chapter card" — a full-screen slide for content the app has no UI for
 * (a roadmap, a scoreboard, a comparison). Keep those as live HTML rather than
 * flat images: the recorder can navigate to a file:// URL and annotate
 * individual rows on camera, which a PNG cannot do.
 *
 *   node render-cards.mjs
 */
import fs from "node:fs";
import path from "node:path";

import { loadPlaywright, ROOT } from "./_config.mjs";

const DIR = path.join(ROOT, "assets");
if (!fs.existsSync(DIR)) { console.log("no assets/ directory — nothing to render"); process.exit(0); }
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".html"));
if (!files.length) { console.log("no assets/*.html — nothing to render"); process.exit(0); }

const { chromium } = await loadPlaywright();
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
for (const f of files) {
  await p.goto("file:///" + path.join(DIR, f).replace(/\\/g, "/"));
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(1200);                       // let webfonts settle
  const out = path.join(DIR, f.replace(/\.html$/, ".png"));
  await p.screenshot({ path: out });
  console.log(`  ✓ ${path.basename(out)}`);
}
await b.close();
console.log("\n  Check each PNG: cards overflow silently when text grows.\n");
