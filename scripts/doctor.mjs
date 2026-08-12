#!/usr/bin/env node
/**
 * doctor.mjs — check this machine can actually produce a smooth recording,
 * BEFORE you spend ten minutes on a take that turns out to judder.
 *
 *   node doctor.mjs                       tools, GPU, capture rate
 *   node doctor.mjs --url https://…       also measure render fps on a real page
 *   node doctor.mjs --file out/x/desktop.mp4   audit an existing capture
 *
 * Three things go wrong, and they look identical in the finished video:
 *
 *  1. SOFTWARE RENDERING. Headless Chromium without GPU flags falls back to
 *     SwiftShader and draws WebGL/canvas at single-digit fps. No encoder
 *     setting can recover frames that were never drawn.
 *  2. CAPTURE CEILING. Playwright's recordVideo streams frames over CDP as
 *     JPEGs and cannot carry 1080p motion — single-digit unique fps even when
 *     the page renders at 60. Desktop Duplication is roughly 5-10× better.
 *  3. TIMEBASE STRETCH. ddagrab stamps frames at the nominal rate whether or
 *     not it produced them that fast. Fall behind and the file covers less wall
 *     time than it claims, so the picture drifts later and later behind the
 *     narration — fine for the first minutes, seconds adrift by the end.
 *
 * Measure unique (non-duplicate) frames, not container fps, and measure on a
 * MOVING page: a static screen legitimately has almost no unique frames, so an
 * average over stillness tells you nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { loadEnv, loadPlaywright, ROOT } from "./_config.mjs";
loadEnv();

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (cmd, a = ["-version"]) => { try { return spawnSync(cmd, a, { encoding: "utf8" }).status === 0; } catch { return false; } };

console.log("\n── tools ───────────────────────────────────────────");
const ff = has(FFMPEG), fp = has(FFPROBE, ["-version"]);
console.log(`  ${ff ? "✓" : "✗"} ffmpeg`);
console.log(`  ${fp ? "✓" : "✗"} ffprobe`);
if (ff) {
  const filters = spawnSync(FFMPEG, ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout || "";
  const encs = spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout || "";
  const dda = /ddagrab/.test(filters), nv = /h264_nvenc/.test(encs);
  console.log(`  ${dda ? "✓" : "✗"} ddagrab   ${dda ? "" : "(no Desktop Duplication — capture.mode must be \"cdp\")"}`);
  console.log(`  ${nv ? "✓" : "✗"} h264_nvenc ${nv ? "" : "(fall back to libx264 -preset ultrafast)"}`);
}
console.log(`  ${process.env.OPENAI_API_KEY ? "✓" : "✗"} OPENAI_API_KEY  (cue alignment + verify-sync)`);
console.log(`  ${process.env.CLOUDTTS_API_KEY ? "✓" : "✗"} CLOUDTTS_API_KEY (voice-over)`);

// ── measure a capture that already exists ────────────────────────────────────
const file = arg("--file", null);
function auditFile(f) {
  console.log(`\n── capture audit: ${path.relative(ROOT, f)} ─────────`);
  const dur = parseFloat((spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", f], { encoding: "utf8" }).stdout || "").trim());
  const n = (from, len, extra = []) => {
    const out = spawnSync(FFMPEG, ["-hide_banner", "-ss", String(from), "-t", String(len), "-i", f, ...extra, "-f", "null", "-"], { encoding: "utf8" });
    const m = /frame=\s*(\d+)/g; let last = 0, r; const log = (out.stderr || "") + (out.stdout || "");
    while ((r = m.exec(log))) last = Number(r[1]);
    return last;
  };
  console.log(`  duration ${dur.toFixed(1)}s`);
  console.log("  unique-frame sampling (look for the MOVING parts):");
  for (const at of [dur * 0.15, dur * 0.5, dur * 0.85]) {
    const len = Math.min(6, Math.max(2, dur * 0.05));
    const tot = n(at, len), uni = n(at, len, ["-vf", "mpdecimate", "-fps_mode", "vfr"]);
    if (!tot) continue;
    const pct = Math.round((uni / tot) * 100);
    console.log(`    t=${at.toFixed(0).padStart(4)}s  ${String(uni).padStart(4)}/${String(tot).padEnd(4)} unique = ${String(pct).padStart(3)}%  (~${Math.round(uni / len)} fps)`);
  }
  console.log("  A moving scene under ~15 fps unique will read as jerky.");
}
if (file) { if (fs.existsSync(file)) auditFile(path.resolve(ROOT, file)); else console.log(`\n✗ no file at ${file}`); }

// ── live capture-rate test ───────────────────────────────────────────────────
if (!file && ff) {
  console.log("\n── desktop capture rate (idle screen, 12s) ─────────");
  const out = path.join(ROOT, "out", "_doctor.mp4");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  const fps = Number(process.env.CAP_FPS || 30);
  const t0 = Date.now();
  const p = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
    "-filter_complex", `ddagrab=output_idx=0:framerate=${fps}:draw_mouse=0,hwdownload,format=bgra`,
    "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-rc", "vbr", "-cq", "20", "-pix_fmt", "yuv420p", out],
    { stdio: ["pipe", "ignore", "ignore"] });
  let died = false; p.on("error", () => { died = true; });
  await sleep(12000);
  const wall = (Date.now() - t0) / 1000;
  await new Promise((r) => { p.on("close", r); try { p.stdin.write("q"); p.stdin.end(); } catch { r(); } setTimeout(r, 8000); });
  if (died || !fs.existsSync(out)) console.log("  ✗ ddagrab did not run — use capture.mode \"cdp\"");
  else {
    const dur = parseFloat((spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", out], { encoding: "utf8" }).stdout || "").trim());
    const drift = ((dur - wall) / wall) * 100;
    console.log(`  wall ${wall.toFixed(1)}s → file ${dur.toFixed(1)}s   drift ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}%`);
    console.log(drift > 1.5
      ? "  ⚠ the capture is already behind on an IDLE screen; it will be worse under load.\n    record.mjs auto-corrects with -itsscale, but reduce the encode cost if you can."
      : "  ✓ holds the nominal rate");
    fs.rmSync(out, { force: true });
  }
}

// ── render rate on a real page ───────────────────────────────────────────────
const url = arg("--url", null);
if (url) {
  const { chromium } = await loadPlaywright();
  console.log("\n── WebGL/canvas render rate ───────────────────────");
  const GPU = ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy",
               "--use-angle=d3d11", "--enable-features=Vulkan,CanvasOopRasterization"];
  for (const [label, headless, extra] of [["headless, no GPU flags", true, []], ["headless + GPU flags", true, GPU], ["headed + GPU flags", false, GPU]]) {
    const c = await chromium.launch({ headless, args: ["--hide-scrollbars", "--force-device-scale-factor=1", ...extra] });
    const pg = await c.newPage({ viewport: { width: 1920, height: 1080 } });
    await pg.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(6000);
    const r = await pg.evaluate(async () => {
      const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
      const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "(no debug info)";
      let n = 0; const tick = () => { n++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      await new Promise((res) => setTimeout(res, 3000));
      return { fps: n / 3, renderer };
    }).catch(() => ({ fps: 0, renderer: "(error)" }));
    console.log(`  ${label.padEnd(24)} ${r.fps.toFixed(1).padStart(6)} fps   ${String(r.renderer).slice(0, 56)}`);
    await c.close();
  }
  console.log("  Target 50+. SwiftShader in that column means software rendering:\n    set the OS per-app GPU preference for chrome.exe to high performance.");
}

console.log("");
