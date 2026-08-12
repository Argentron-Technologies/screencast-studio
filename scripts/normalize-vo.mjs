#!/usr/bin/env node
/**
 * normalize-vo.mjs — loudness-normalize the generated VO clips.
 *
 * ElevenLabs clips can drift a few dB between scenes. This applies a two-pass
 * EBU R128 loudnorm (ffmpeg) so every scene's voice sits at the same perceived
 * level, then re-measures each clip and updates public/vo/leadgen/manifest.json.
 *
 *   npm run vo:leadgen          # generate (raw)
 *   npm run normalize:leadgen   # THIS — normalize in place, idempotent
 *   npm run build:leadgen       # render
 *
 * Env:
 *   VO_LUFS                (default -16   integrated loudness target, LUFS)
 *   VO_TP                  (default -1.5  true-peak ceiling, dBTP)
 *   VO_LRA                 (default 11    loudness range)
 *   VO_TAIL_GAP_SECONDS    (default 0.5   end-gap, kept in sync with generator)
 *   VO_TAIL_PAD_FRAMES     (optional override of the gap in raw frames)
 *   FFMPEG                 (default "ffmpeg" — path to the ffmpeg binary)
 *
 * Flags:
 *   --force   re-normalize even clips already marked normalized
 *   --scene <id>   only this scene (repeatable)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const argValue = (f) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};
// --script/--out mirror generate-vo.mjs so this serves the Reels too.
const SCRIPT_PATH = path.resolve(ROOT, argValue("--script") || path.join("content", "leadgen.script.json"));
const PUBLIC_PREFIX = (argValue("--out") || "vo/leadgen").replace(/^\/+|\/+$/g, "");
const OUT_DIR = path.join(ROOT, "public", ...PUBLIC_PREFIX.split("/"));
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");

const FORCE = args.includes("--force");
const onlyScenes = args.reduce((a, x, i) => (x === "--scene" && args[i + 1] ? [...a, args[i + 1]] : a), []);

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const LUFS = process.env.VO_LUFS ? Number(process.env.VO_LUFS) : -14; // YouTube loudness standard (louder than the -16 podcast level)
const TP = process.env.VO_TP ? Number(process.env.VO_TP) : -1.0;
const LRA = process.env.VO_LRA ? Number(process.env.VO_LRA) : 11;
// Short fade-in to mask any onset click/breath artifact at the very start of a
// clip, and a matching fade-out so the tail into the silent gap is clean.
const FADE_IN = process.env.VO_FADE_IN_SECONDS ? Number(process.env.VO_FADE_IN_SECONDS) : 0.06;
const FADE_OUT = process.env.VO_FADE_OUT_SECONDS ? Number(process.env.VO_FADE_OUT_SECONDS) : 0.08;
const FFPROBE = process.env.FFPROBE || "ffprobe";

const script = JSON.parse(fs.readFileSync(SCRIPT_PATH, "utf8"));
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
manifest.scenes = manifest.scenes || {};
const FPS = manifest.fps || script.meta?.fps || 30;
const TAIL_PAD_FRAMES = process.env.VO_TAIL_PAD_FRAMES
  ? Number(process.env.VO_TAIL_PAD_FRAMES)
  : Math.round((process.env.VO_TAIL_GAP_SECONDS ? Number(process.env.VO_TAIL_GAP_SECONDS) : 0.5) * FPS);

// ffmpeg logs to stderr even on success, so capture both streams via spawnSync.
const ff = (a) => {
  const r = spawnSync(FFMPEG, a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  const out = `${r.stderr || ""}\n${r.stdout || ""}`;
  if (r.status !== 0) throw new Error(`ffmpeg exited ${r.status}\n${out}`);
  return out;
};

async function measureSeconds(file, bytes) {
  try {
    const mm = await import("music-metadata");
    const meta = await mm.parseFile(file, { duration: true });
    if (meta?.format?.duration) return meta.format.duration;
  } catch {}
  // ffprobe BEFORE the size guess. `music-metadata` is not a dependency of this
  // project, so the import always throws and the old code fell straight through
  // to a size÷128 kbps estimate — while the generator and this script both
  // write 192 kbps. Every duration came out exactly 1.5× too long, which the
  // recorder then spent holding each scene 50% past the end of its narration.
  // Caught 2026-08-11 by comparing manifest.seconds against ffprobe.
  try {
    const out = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=nk=1:nw=1", file], { encoding: "utf8" }).stdout;
    const d = parseFloat((out || "").trim());
    if (Number.isFinite(d) && d > 0) return d;
  } catch {}
  console.log(`\n    ⚠ could not probe ${path.basename(file)} — falling back to a 192 kbps size estimate`);
  return (bytes * 8) / 192000;
}

function analyze(file) {
  // Pass 1 — measure. loudnorm prints a JSON blob to stderr.
  const stderr = ff(["-hide_banner", "-i", file, "-af",
    `loudnorm=I=${LUFS}:TP=${TP}:LRA=${LRA}:print_format=json`, "-f", "null", "-"]);
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`Could not parse loudnorm analysis for ${path.basename(file)}`);
  return JSON.parse(stderr.slice(start, end + 1));
}

function normalize(file, m, durationSeconds) {
  // Pass 2 — apply loudnorm (linear: constant gain), then short fades to clean
  // the onset/tail. Fade-out only if we know the duration.
  const tmp = path.join(os.tmpdir(), `vo-norm-${path.basename(file)}`);
  const filters = [
    `loudnorm=I=${LUFS}:TP=${TP}:LRA=${LRA}:` +
      `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:` +
      `measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`,
  ];
  if (FADE_IN > 0) filters.push(`afade=t=in:st=0:d=${FADE_IN}`);
  if (FADE_OUT > 0 && durationSeconds > FADE_OUT) filters.push(`afade=t=out:st=${(durationSeconds - FADE_OUT).toFixed(3)}:d=${FADE_OUT}`);
  ff(["-hide_banner", "-y", "-i", file, "-af", filters.join(","),
    "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", tmp]);
  fs.copyFileSync(tmp, file);
  fs.rmSync(tmp, { force: true });
}

async function main() {
  // Flat { scenes:[…] } (LeadGen) or grouped { reels:[{ scenes:[…] }] } (Reels).
  const allScenes = Array.isArray(script.scenes)
    ? script.scenes
    : Array.isArray(script.reels)
      ? script.reels.flatMap((r) => r.scenes || [])
      : [];
  const scenes = onlyScenes.length ? allScenes.filter((s) => onlyScenes.includes(s.id)) : allScenes;
  console.log(`\nLoudness normalize — target ${LUFS} LUFS, TP ${TP} dBTP, LRA ${LRA} (ffmpeg)\n`);

  let done = 0, skipped = 0;
  for (const s of scenes) {
    const entry = manifest.scenes[s.id];
    if (!entry) { console.log(`  --    ${s.id.padEnd(20)} (no audio yet — run vo:leadgen first)`); continue; }
    const file = path.join(OUT_DIR, path.basename(entry.file));
    if (!fs.existsSync(file)) { console.log(`  --    ${s.id.padEnd(20)} (file missing)`); continue; }
    if (entry.normalized && !FORCE) { console.log(`  skip  ${s.id.padEnd(20)} (already normalized)`); skipped++; continue; }

    process.stdout.write(`  norm  ${s.id.padEnd(20)} …`);
    const meas = analyze(file);
    normalize(file, meas, entry.seconds);
    const stat = fs.statSync(file);
    const seconds = await measureSeconds(file, stat.size);
    entry.seconds = Math.round(seconds * 1000) / 1000;
    entry.durationInFrames = Math.ceil(seconds * FPS) + TAIL_PAD_FRAMES;
    entry.normalized = true;
    entry.loudness = { I: LUFS, TP, LRA, input_i: Number(meas.input_i) };
    console.log(` was ${Number(meas.input_i).toFixed(1)} LUFS → ${LUFS} LUFS  (${entry.durationInFrames}f)`);
    done++;
  }

  manifest.normalizedAt = new Date().toISOString();
  manifest.loudnessTarget = { I: LUFS, TP, LRA };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\n✓ ${done} normalized, ${skipped} unchanged. Manifest updated.\n`);
}

main().catch((e) => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
