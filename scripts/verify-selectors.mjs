#!/usr/bin/env node
/**
 * verify-selectors.mjs — walk every scene and report, per selector, how many
 * elements it matches and what the match SAYS.
 *
 * `:has-text()` is a case-insensitive substring match returning the first hit,
 * so a selector can quietly box the wrong element and you only discover it by
 * watching the finished video. Printing the matched text makes a wrong match
 * obvious in a scroll.
 *
 *   MODULE=tour node verify-selectors.mjs
 *
 * It uses the same .auth/profile as the recorder, so it doubles as a session
 * check. Scenes reached by CLICKING rather than navigating can't be replayed
 * here — give those a `verifyGoto` (and optionally `verifyReady`) in the config
 * so the verifier knows where to stand, or every one of their selectors will
 * report a false zero.
 */
import path from "node:path";

import { loadConfig, loadPlaywright, ROOT } from "./_config.mjs";

const { mod, name, app } = await loadConfig({ needsApp: true });
const { chromium } = await loadPlaywright();
const PROFILE = path.join(ROOT, ".auth", "profile");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true, viewport: { width: 1920, height: 1080 },
  args: ["--hide-scrollbars", "--force-device-scale-factor=1"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto(app + (mod.route || "/"), { waitUntil: "domcontentloaded" });
await Promise.race([
  page.locator(mod.ready || "body").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {}),
  page.locator("input[type=password]").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {}),
]);
await sleep(1500);
if (await page.locator("input[type=password]").first().isVisible().catch(() => false)) {
  console.error("\n✗ not signed in — run: node record.mjs --login\n");
  await ctx.close(); process.exit(1);
}

async function report(sel, note = "", nth = null) {
  if (!sel) return 0;
  let n = 0, txt = "";
  try {
    n = await page.locator(sel).count();
    const pick = nth != null ? Math.min(nth, Math.max(0, n - 1)) : 0;
    if (n) txt = ((await page.locator(sel).nth(pick).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 66);
  } catch (e) { console.log(`      ✗ BAD SELECTOR  ${sel}  (${e.message.split("\n")[0]})`); return 1; }
  const wanted = nth != null ? nth + 1 : 1;
  const short = n < wanted;
  console.log(`      ${n === 0 || short ? "✗" : n === 1 ? "✓" : "•"} n=${String(n).padEnd(3)} ${sel}${nth != null ? `  [nth=${nth}]` : ""}${note}${short ? "   <<< FEWER MATCHES THAN nth" : ""}`);
  if (n) console.log(`            “${txt}”`);
  return n === 0 || short ? 1 : 0;
}

let bad = 0;
for (const s of mod.scenes) {
  console.log(`\n── ${s.id} ${"─".repeat(Math.max(0, 48 - s.id.length))}`);
  const dest = s.goto || s.verifyGoto;
  if (dest) {
    const u = /^(file:|https?:)/.test(dest) ? dest : app + dest;
    await page.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(s.gotoWait || 2500);
    const ready = s.ready || s.verifyReady;
    if (ready) await page.locator(ready).first().waitFor({ state: "visible", timeout: 40000 })
      .catch(() => { bad++; console.log(`      ✗ ready selector never appeared: ${ready}`); });
  }
  // Steps whose target only exists after an async run or a canvas pick can't be
  // checked from a cold page; list them in the scene as `deferred: [sel, …]`.
  const deferred = new Set(s.deferred || []);
  for (const st of s.steps) {
    if (st.do === "wait") continue;
    if (deferred.has(st.sel)) { console.log(`      · (deferred — only exists mid-run) ${st.sel}`); continue; }
    if (st.do === "orbit" || st.do === "canvasClick") {
      bad += await report(st.sel || "canvas", "   [canvas]");
      if (st.after) console.log(`      · (probe after pick, ${st.tries?.length || 1} candidate point(s)) ${st.after}`);
      continue;
    }
    if (st.union) { bad += await report(Array.isArray(st.union) ? st.union[0] : st.union, "   [union]"); continue; }
    const miss = await report(st.sel, "", st.nth);
    if (miss && st.altSel) bad += await report(st.altSel, "   [alt]", st.nth);
    else bad += miss;
  }
}
console.log("\n✓ = one match  • = several (the nth shown is the one taken)  ✗ = none");
console.log(bad ? `\n✗ ${bad} selector(s) matched nothing — fix before recording\n` : "\n✓ every selector resolves\n");
await ctx.close();
process.exit(bad ? 1 : 0);
