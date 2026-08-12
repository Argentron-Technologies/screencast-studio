#!/usr/bin/env node
/**
 * refresh-durations.mjs — re-probe every VO mp3 with ffprobe and rewrite
 * `seconds` / `durationInFrames` in the manifest. Non-destructive: it never
 * touches the audio, only the numbers the recorder holds each scene for.
 *
 * WHY: `normalize-vo.mjs` used to estimate duration from file size at a
 * hard-coded 128 kbps whenever the optional `music-metadata` package was
 * absent — which it always is here — while writing 192 kbps files. Every scene
 * came out exactly 1.5× too long, so the recorder sat on each one for 50%
 * past the end of its narration. normalize-vo now probes properly; this script
 * repairs a manifest that was already written with the bad numbers, without
 * re-encoding (mp3→mp3 twice is a pointless generation loss).
 *
 *   node scripts/refresh-durations.mjs --out vo/intro
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PREFIX = arg("--out", "vo/intro").replace(/^\/+|\/+$/g, "");
const DIR = path.join(ROOT, "public", ...PREFIX.split("/"));
const MP = path.join(DIR, "manifest.json");
const FFPROBE = process.env.FFPROBE || "ffprobe";

const man = JSON.parse(fs.readFileSync(MP, "utf8"));
const FPS = man.fps || 30;
const TAIL = process.env.VO_TAIL_PAD_FRAMES ? Number(process.env.VO_TAIL_PAD_FRAMES)
  : Math.round((process.env.VO_TAIL_GAP_SECONDS ? Number(process.env.VO_TAIL_GAP_SECONDS) : 0.5) * FPS);

let changed = 0, total = 0;
console.log(`\nre-probing ${PREFIX} (fps=${FPS}, tail pad=${TAIL}f)\n`);
for (const [id, e] of Object.entries(man.scenes)) {
  const f = path.join(ROOT, "public", ...e.file.split("/"));
  if (!fs.existsSync(f)) { console.log(`  ✗ ${id.padEnd(14)} missing ${e.file}`); continue; }
  const out = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", f], { encoding: "utf8" }).stdout;
  const d = parseFloat((out || "").trim());
  if (!Number.isFinite(d) || d <= 0) { console.log(`  ✗ ${id.padEnd(14)} ffprobe gave nothing`); continue; }
  const was = e.seconds, wasF = e.durationInFrames;
  e.seconds = Math.round(d * 1000) / 1000;
  e.durationInFrames = Math.ceil(d * FPS) + TAIL;
  total += e.durationInFrames;
  const diff = Math.abs(was - e.seconds) > 0.05;
  if (diff) changed++;
  console.log(`  ${diff ? "↻" : "·"} ${id.padEnd(14)} ${String(was).padStart(7)}s → ${String(e.seconds).padStart(7)}s   ${String(wasF).padStart(5)}f → ${String(e.durationInFrames).padStart(5)}f`);
}
fs.writeFileSync(MP, JSON.stringify(man, null, 2) + "\n");
const s = total / FPS;
console.log(`\n✓ ${changed} corrected. Screen time now ≈ ${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}\n`);
