#!/usr/bin/env node
/**
 * verify-sync.mjs — prove the picture and the voice-over agree, and emit exact
 * chapter times as a by-product.
 *
 * Do not estimate chapter times by scaling recorded offsets: the stitch's
 * gap-speed compresses only the silent stretches, so a linear estimate drifts —
 * far enough to shift a late chapter by a whole scene. This transcribes the
 * FINISHED mix with word timestamps, finds where each scene's narration really
 * starts, and grabs the frame showing at that moment. Comparing the two is the
 * only check that actually proves sync.
 *
 *   MODULE=tour node verify-sync.mjs [--mp4 out/tutorials/tour/tour.mp4]
 *
 * Requires OPENAI_API_KEY (word-level transcription). Writes out/sync/*.png and
 * a contact strip so you can eyeball every scene opening at once.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, ROOT, fmt } from "./_config.mjs";

const { mod, name } = await loadConfig();
const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MP4 = path.resolve(ROOT, arg("--mp4", `out/tutorials/${name}/${name}.mp4`));
const SCRIPT = path.join(ROOT, "content", `${name}.script.json`);
const OUTDIR = path.join(ROOT, "out", "sync");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const KEY = process.env.OPENAI_API_KEY;

if (!KEY) { console.error("OPENAI_API_KEY required (word-level transcription)"); process.exit(1); }
if (!fs.existsSync(MP4)) { console.error(`no mp4 at ${path.relative(ROOT, MP4)}`); process.exit(1); }
if (!fs.existsSync(SCRIPT)) { console.error(`no script at ${path.relative(ROOT, SCRIPT)}`); process.exit(1); }

fs.mkdirSync(OUTDIR, { recursive: true });
const mix = path.join(OUTDIR, "_mix.mp3");
spawnSync(FFMPEG, ["-v", "error", "-y", "-i", MP4, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", mix]);

console.log("\n  transcribing the final mix …");
const fd = new FormData();
fd.append("file", new Blob([fs.readFileSync(mix)], { type: "audio/mpeg" }), "mix.mp3");
fd.append("model", process.env.OPENAI_ALIGN_MODEL || "whisper-1");
fd.append("response_format", "verbose_json");
fd.append("timestamp_granularities[]", "word");
const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: fd });
if (!res.ok) { console.error(`transcription ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
const words = (await res.json()).words || [];
if (!words.length) { console.error("no word timestamps returned"); process.exit(1); }

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const hay = words.map((w) => norm(w.word)).filter(Boolean);
// search forward only, so a repeated phrase can't match an earlier scene
const findFrom = (needle, from) => {
  for (let i = from; i < hay.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
};

const titles = mod.titles || {};
const scenes = JSON.parse(fs.readFileSync(SCRIPT, "utf8")).scenes;
let cursor = 0, found = 0;
const rows = [];
for (const sc of scenes) {
  const needle = norm(sc.narration).split(" ").slice(0, 5);
  const at = findFrom(needle, cursor);
  if (at < 0) { console.log(`  ✗ ${sc.id.padEnd(16)} opening line not found in transcript`); rows.push(null); continue; }
  cursor = at + needle.length;
  rows.push({ id: sc.id, t: words[at].start });
  found++;
  // a frame 3.5 s in, by which point the scene's first action has landed
  spawnSync(FFMPEG, ["-v", "error", "-y", "-ss", String(words[at].start + 3.5), "-i", MP4, "-frames:v", "1",
    "-vf", "crop=iw:150:0:0,scale=760:-1", path.join(OUTDIR, `${sc.id}.png`)]);
}

const list = rows.filter(Boolean).map((r) => path.join(OUTDIR, `${r.id}.png`)).filter(fs.existsSync);
if (list.length) {
  const lst = path.join(OUTDIR, "_list.txt");
  fs.writeFileSync(lst, list.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
  spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
    "-vf", `tile=1x${list.length}`, "-frames:v", "1", path.join(ROOT, "out", "sync-strip.png")]);
}

console.log(`\n  ${found}/${scenes.length} scene openings located in the finished audio\n`);
console.log("  CHAPTERS (measured from the final mix):\n");
for (const r of rows) if (r) console.log(`${fmt(r.t)}  ${titles[r.id] || r.id}`);
console.log(`\n  frames → out/sync/*.png, strip → out/sync-strip.png`);
console.log("  Check each row shows the screen its narration describes.\n");
