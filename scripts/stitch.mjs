#!/usr/bin/env node
/**
 * stitch-mcp.mjs — assemble the MCP-driven screen capture + Aria VO into
 * out/sample-tutorial.mp4, synced via the magenta marker flash.
 *
 * The driver flashed a full-screen magenta frame at its t0 and logged each
 * scene's offset from t0 (out/tour/timeline-mcp.json). Here we:
 *   1. find the marker's video-time with `signalstats` (UAVG/VAVG both high),
 *   2. trim the video to just after the flash (clean dashboard open),
 *   3. place each narration at (offset - flashDur), independent of pre-roll,
 *   4. mix + mux + encode, cutting the tail after the last clip.
 *
 *   node scripts/stitch-mcp.mjs
 * Env: AUDIO_NUDGE (s, +later/-earlier), TOUR_ENDPAD (s, default 1.0)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";
const NUDGE = Number(process.env.AUDIO_NUDGE || 0);
const ENDPAD = Number(process.env.TOUR_ENDPAD || 1.0);
const AR = Number(process.env.OUT_SAMPLE_RATE || 48000);     // 48 kHz output
const VO_LUFS = Number(process.env.VO_LUFS || -16);          // narration loudness
const MUSIC_LUFS = Number(process.env.MUSIC_LUFS || -28);    // quiet bed, well under VO
const MUSIC_FILE = process.env.MUSIC_FILE || path.join(ROOT, "music", "urban-01.mp3");

const TL = process.env.TOUR_TL ? path.resolve(ROOT, process.env.TOUR_TL) : path.join(ROOT, "out", "tour", "timeline-mcp.json");
const OUT = process.env.OUT_FILE ? path.resolve(ROOT, process.env.OUT_FILE) : path.join(ROOT, "out", "sample-tutorial.mp4");

const OUT_W = Number(process.env.OUT_W || 1920);
const OUT_H = Number(process.env.OUT_H || 1080);
const END_CARD = process.env.END_CARD !== "0";
const END_LOGO = process.env.END_LOGO || path.resolve(ROOT, "..", "aspnet-core", "logos", "logo.png");
const END_IMAGE = process.env.END_IMAGE || "";   // full-frame pre-rendered end card (overrides logo+text)
const END_TEXT = process.env.END_TEXT || "Make your first BricksDeck — free at bricksdeck.com";
const END_DUR = Number(process.env.END_DUR || 5);
const END_BG = process.env.END_BG || "0xF3EDE1";   // brand cream
const END_FG = process.env.END_FG || "0x1A1A1A";   // brand ink
const END_FONT = (process.env.END_FONT || "C:/Windows/Fonts/georgia.ttf").replace(/\\/g, "/");
const OUTRO_HANDOFF = process.env.OUTRO_HANDOFF !== "0";  // move the last scene's later sentences onto the end card
const END_TAIL = Number(process.env.END_TAIL || 0.9);     // silent tail after the outro VO on the end card

// Video encoder. Default = libx264 (CPU, proven quality/size). HWENC=nvenc uses
// the NVIDIA GPU (NVENC) for ~3-5x faster re-encodes at near-equivalent quality;
// HWENC=qsv uses Intel Quick Sync. Filters run on CPU either way.
const HWENC = (process.env.HWENC || "").toLowerCase();
const VENC = HWENC === "nvenc"
  ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "20", "-b:v", "0", "-pix_fmt", "yuv420p"]
  : HWENC === "qsv"
  ? ["-c:v", "h264_qsv", "-global_quality", "20", "-pix_fmt", "yuv420p"]
  : ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"];

const SILENCE_MAX = Number(process.env.TRIM_SILENCE ?? 0);     // cut narration gaps longer than this; 0 = OFF (default)
// Asymmetric trim: the click→load transition sits at the END of a silent gap,
// so cut the dead pause at the START and KEEP the end (the click into next scene).
const SILENCE_START_PAD = Number(process.env.SILENCE_START_PAD || 0.3); // kept just after narration ends
const SILENCE_END_KEEP = Number(process.env.SILENCE_END_KEEP || 3.8);  // kept before next narration (the click/nav)

// GAP_SPEED: instead of CUTTING silent gaps, SPEED them up (time-lapse) so the
// action is still shown but dead time shrinks — keeps flow. Adaptive: a gap is
// sped so its remaining length is ≤ GAP_MAX_KEEP (faster for longer waits).
const GAP_SPEED = Number(process.env.GAP_SPEED || 0);          // base speed-up factor; 0 = OFF
const GAP_MIN = Number(process.env.GAP_MIN || 2.5);            // only speed gaps longer than this (s)
const GAP_PAD = Number(process.env.GAP_PAD || 0.5);            // 1× transition pad kept at each gap end
const GAP_MAX_KEEP = Number(process.env.GAP_MAX_KEEP || 7);    // target max length of a sped-up gap (s); 0 = fixed GAP_SPEED

// Decompose a tempo factor into a chain of atempo (each must be 0.5–2.0).
function atempoChain(s) {
  const out = []; let r = s;
  while (r > 2.0001) { out.push("atempo=2.0"); r /= 2.0; }
  while (r < 0.5 - 1e-6) { out.push("atempo=0.5"); r /= 0.5; }
  if (Math.abs(r - 1) > 1e-3) out.push(`atempo=${r.toFixed(4)}`);
  return out.join(",");
}

// Build {a,b,speed} segments over [0,total]: narrated parts at 1×, silent
// gap-middles sped up (adaptive). Keeps a GAP_PAD at each gap end at 1× so
// transitions don't snap.
function buildSpeedSegments(silences, total) {
  const segs = []; let cur = 0;
  for (const [s, e] of silences) {
    if (e - s <= GAP_MIN) continue;
    const gs = Math.max(cur, s + GAP_PAD), ge = e - GAP_PAD;
    if (ge - gs < 0.4) continue;
    let speed = GAP_SPEED;
    if (GAP_MAX_KEEP > 0 && (ge - gs) / speed > GAP_MAX_KEEP) speed = (ge - gs) / GAP_MAX_KEEP;
    speed = Math.min(speed, 8);
    if (gs > cur) segs.push({ a: cur, b: gs, speed: 1 });
    segs.push({ a: gs, b: ge, speed });
    cur = ge;
  }
  if (cur < total) segs.push({ a: cur, b: total, speed: 1 });
  return segs;
}

const probe = (f) => parseFloat((spawnSync(FFPROBE, ["-v","error","-show_entries","format=duration","-of","default=nk=1:nw=1", f], {encoding:"utf8"}).stdout||"").trim()) || 0;

function ff(args, label) {
  const r = spawnSync(FFMPEG, args, { encoding: "utf8", cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg [${label}] exited ${r.status}\n${(r.stderr || "").slice(-1400)}`);
  return r;
}

// silencedetect on the narration → [[start,end], …] of gaps ≥ SILENCE_MAX.
function detectSilence(wav, minDur) {
  const r = spawnSync(FFMPEG, ["-i", wav, "-af", `silencedetect=noise=-45dB:d=${minDur}`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const log = (r.stderr || "") + (r.stdout || "");
  const ivals = []; let s = null;
  for (const line of log.split(/\r?\n/)) {
    let m;
    if ((m = /silence_start:\s*(-?[0-9.]+)/.exec(line))) s = Math.max(0, parseFloat(m[1]));
    else if ((m = /silence_end:\s*([0-9.]+)/.exec(line))) { if (s != null) { ivals.push([s, parseFloat(m[1])]); s = null; } }
  }
  return ivals;
}

// Branded end card. END_IMAGE (full-frame 1920x1080 PNG, pre-rendered) takes
// precedence over the color+logo+drawtext composition. If voFile is given it
// carries the outro VO (duration = dur); otherwise it's silent for END_DUR.
function makeEndCard(out, voFile, dur) {
  const d = voFile ? dur : END_DUR;
  if (END_IMAGE && fs.existsSync(END_IMAGE)) {
    const audioIn = voFile ? ["-i", voFile] : ["-f", "lavfi", "-i", `anullsrc=r=${AR}:cl=stereo`];
    const fc = `[0:v]scale=${OUT_W}:${OUT_H},fade=t=in:st=0:d=0.5,format=yuv420p[v];[1:a]apad,aresample=${AR}[a]`;
    ff(["-y", "-loop", "1", "-framerate", "30", "-t", d.toFixed(2), "-i", END_IMAGE, ...audioIn,
      "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-t", d.toFixed(2),
      ...VENC, "-c:a", "pcm_s16le", "-ar", String(AR), out], "endcard");
    return;
  }
  const font = END_FONT.replace(/^([A-Za-z]):/, "$1\\:");          // escape drive colon for the filtergraph
  const text = END_TEXT.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "");
  const audioIn = voFile ? ["-i", voFile] : ["-f", "lavfi", "-i", `anullsrc=r=${AR}:cl=stereo`];
  const fc =
    `[1:v]scale=820:-1[logo];` +
    `[0:v][logo]overlay=(W-w)/2:(H-h)/2-60[bg];` +
    `[bg]drawtext=fontfile='${font}':text='${text}':fontcolor=${END_FG}:fontsize=46:x=(w-text_w)/2:y=H/2+150,fade=t=in:st=0:d=0.5,format=yuv420p[v];` +
    `[2:a]apad,aresample=${AR}[a]`;
  ff(["-y", "-f", "lavfi", "-i", `color=c=${END_BG}:s=${OUT_W}x${OUT_H}:r=30:d=${d.toFixed(2)}`,
    "-i", END_LOGO, ...audioIn,
    "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-t", d.toFixed(2),
    ...VENC, "-c:a", "pcm_s16le", "-ar", String(AR), out], "endcard");
}

function concatVideos(a, b, out) {
  ff(["-y", "-i", a, "-i", b, "-filter_complex", "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
    "-map", "[v]", "-map", "[a]", ...VENC,
    "-c:a", "pcm_s16le", "-ar", String(AR), out], "concat");
}

// Turn silence gaps into the segments to KEEP over [0,total]: cut the middle of
// each gap, leaving SILENCE_PAD at both ends so transitions don't snap.
function keepSegments(silences, total) {
  // Cut [s+START_PAD, e-END_KEEP] — removes the dead pause but keeps the
  // click/nav transition that lives at the end of the gap.
  const cuts = silences.map(([s, e]) => [s + SILENCE_START_PAD, e - SILENCE_END_KEEP]).filter(([a, b]) => b - a > 0.2);
  const keep = []; let cur = 0;
  for (const [a, b] of cuts) { if (a > cur) keep.push([cur, a]); cur = Math.max(cur, b); }
  if (cur < total) keep.push([cur, total]);
  return keep.filter(([a, b]) => b - a > 0.05);
}

function findMarker(video) {
  // signalstats per-frame; magenta (255,0,255) → both UAVG and VAVG high.
  // Use a RELATIVE file= path (cwd=ROOT) so the Windows drive colon in an
  // absolute path doesn't get parsed as a filter-option separator.
  const statsRel = "out/tour/stats.txt";
  const stats = path.join(ROOT, "out", "tour", "stats.txt");
  spawnSync(FFMPEG, ["-y","-i",video,"-t","70","-vf",`signalstats,metadata=print:file=${statsRel}`,"-an","-f","null","-"], {encoding:"utf8", cwd:ROOT, maxBuffer:128*1024*1024});
  const txt = fs.readFileSync(stats, "utf8");
  let t = null, U = null, V = null;
  for (const line of txt.split(/\r?\n/)) {
    let m;
    if ((m = /pts_time:([0-9.]+)/.exec(line))) { t = parseFloat(m[1]); U = V = null; }
    else if ((m = /UAVG=([0-9.]+)/.exec(line))) U = parseFloat(m[1]);
    else if ((m = /VAVG=([0-9.]+)/.exec(line))) { V = parseFloat(m[1]);
      if (t != null && U != null && V != null && U > 150 && V > 175) return t; // magenta frame
    }
  }
  return null;
}

function main() {
  const tl = JSON.parse(fs.readFileSync(TL, "utf8"));
  const video = path.resolve(ROOT, tl.video);
  if (!fs.existsSync(video)) throw new Error(`Video missing: ${video}`);

  const clips = tl.offsets.map((o) => ({ ...o, file: path.join(ROOT, tl.voDir, `${o.id}.mp3`) }))
    .filter((c) => fs.existsSync(c.file));
  if (!clips.length) throw new Error("No narration mp3s found — run tour:vo first.");

  // tl.t0 (webm seconds of the recorder's t0) skips magenta detection — used by the
  // WhatsApp recorder, where a JS flash isn't reliably captured over WhatsApp Web.
  const marker = (tl.t0 != null) ? tl.t0 : findMarker(video);
  if (marker == null) throw new Error("Sync marker (magenta flash) not found in first 70s.");
  const trimStart = marker + (tl.t0 != null ? 0 : tl.flashDur);
  console.log(`\nMarker @ ${marker.toFixed(2)}s → video starts at ${trimStart.toFixed(2)}s\n`);

  // ── 1. narration mix → loudnorm wav (48 kHz) ──────────────────────────────
  const voIns = [], parts = [], labels = [];
  let lastEnd = 0;
  clips.forEach((c, i) => {
    const delay = Math.max(0, c.offset - tl.flashDur + NUDGE);
    const dur = probe(c.file);
    lastEnd = Math.max(lastEnd, delay + dur);
    voIns.push("-i", c.file);
    parts.push(`[${i}:a]adelay=${Math.round(delay * 1000)}:all=1[a${i}]`);
    labels.push(`[a${i}]`);
    console.log(`  ${c.id.padEnd(16)} narration at ${delay.toFixed(2)}s  (${dur.toFixed(1)}s)`);
  });
  const outDur = lastEnd + ENDPAD;
  const voMix = path.join(ROOT, "out", "tour", "vo-mix.wav");
  ff(["-y", ...voIns, "-filter_complex",
    parts.join(";") + ";" + labels.join("") + `amix=inputs=${clips.length}:duration=longest:normalize=0,loudnorm=I=${VO_LUFS}:TP=-1.5:LRA=11[a]`,
    "-map", "[a]", "-t", outDur.toFixed(2), "-ar", String(AR), "-ac", "2", voMix], "vo-mix");

  // ── 2. silent narration gaps → SPEED UP (preferred) or cut ────────────────
  // segs = ordered {a,b,speed} over [0,outDur]; 1× = normal, >1 = time-lapse.
  let segs = [{ a: 0, b: outDur, speed: 1 }];
  if (GAP_SPEED > 1) {
    const sil = detectSilence(voMix, GAP_MIN);
    segs = buildSpeedSegments(sil, outDur);
    const neu = segs.reduce((s, x) => s + (x.b - x.a) / x.speed, 0);
    const sped = segs.filter((x) => x.speed > 1).length;
    console.log(`\n  gap-speed ×${GAP_SPEED} (≤${GAP_MAX_KEEP}s): ${sped} gap(s) sped up, ${outDur.toFixed(1)}s → ${neu.toFixed(1)}s`);
  } else if (SILENCE_MAX > 0) {
    const sil = detectSilence(voMix, SILENCE_MAX);
    const keep = keepSegments(sil, outDur);
    segs = keep.map(([a, b]) => ({ a, b, speed: 1 }));
    const removed = outDur - keep.reduce((s, [a, b]) => s + (b - a), 0);
    console.log(`\n  silence: ${sil.length} gap(s) >${SILENCE_MAX}s → cut ${removed.toFixed(1)}s, ${keep.length} segments kept`);
  }

  // ── 2.5 outro handoff: split the last scene — keep its first sentence over
  // the footage, slice the rest (summary + CTA) onto the end card's VO ───────
  let endVo = null, endVoDur = 0;
  if (OUTRO_HANDOFF && END_CARD) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, tl.voDir, "manifest.json"), "utf8"));
    const last = clips[clips.length - 1];
    const lc = manifest.scenes?.[last.id]?.cues || [];
    const lsec = manifest.scenes?.[last.id]?.seconds || 0;
    if (lc.length >= 2) {
      const split = lc[1].start;
      const videoEnd = Math.max(0, last.offset - tl.flashDur + NUDGE) + split;
      segs = segs.map((s) => ({ ...s, b: Math.min(s.b, videoEnd) })).filter((s) => s.b - s.a > 0.05);
      endVo = path.join(ROOT, "out", "tour", "endcard-vo.wav");
      ff(["-y", "-i", last.file, "-af", `atrim=start=${split},asetpts=PTS-STARTPTS,loudnorm=I=${VO_LUFS}:TP=-1.5:LRA=11`, "-ar", String(AR), "-ac", "2", endVo], "end-vo");
      endVoDur = (lsec - split) + END_TAIL;
      console.log(`\n  outro handoff: footage ends at ${videoEnd.toFixed(1)}s · end card carries ${(lsec - split).toFixed(1)}s of outro VO`);
    }
  }

  // ── 3. cut video (+VO) to the keep-segments (frame-accurate, no -ss) ───────
  const narrated = path.join(ROOT, "out", "tour", "narrated.mkv");
  const seg = [], cat = [];
  segs.forEach(({ a, b, speed }, i) => {
    seg.push(`[0:v]trim=${(trimStart + a).toFixed(3)}:${(trimStart + b).toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(4)}[v${i}]`);
    const at = speed === 1 ? "" : "," + atempoChain(speed);
    seg.push(`[1:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS${at}[b${i}]`);
    cat.push(`[v${i}][b${i}]`);
  });
  ff(["-y", "-i", video, "-i", voMix, "-filter_complex",
    seg.join(";") + ";" + cat.join("") + `concat=n=${segs.length}:v=1:a=1[vout][aout]`,
    "-map", "[vout]", "-map", "[aout]", ...VENC,
    "-c:a", "pcm_s16le", "-ar", String(AR), narrated], "cut");

  // ── 3.5 append the branded CTA end card ───────────────────────────────────
  let body = narrated;
  const hasEndImage = END_IMAGE && fs.existsSync(END_IMAGE);
  if (END_CARD && (hasEndImage || fs.existsSync(END_LOGO))) {
    const endcard = path.join(ROOT, "out", "tour", "endcard.mkv");
    makeEndCard(endcard, endVo, endVoDur);
    const full = path.join(ROOT, "out", "tour", "narrated-full.mkv");
    concatVideos(narrated, endcard, full);
    body = full;
    console.log(`\n  + end card (${(endVo ? endVoDur : END_DUR).toFixed(1)}s${endVo ? ", voiced" : ""}, ${hasEndImage ? path.relative(ROOT, END_IMAGE) : path.relative(ROOT, END_LOGO)})`);
  } else if (END_CARD) {
    console.log(`\n  (end card skipped — need END_IMAGE (${END_IMAGE || "unset"}) or logo at ${path.relative(ROOT, END_LOGO)})`);
  }

  // ── 4. duck the music bed under the narration → final (48 kHz) ─────────────
  if (fs.existsSync(MUSIC_FILE)) {
    console.log(`  music bed: ${path.relative(ROOT, MUSIC_FILE)} (ducked, ${MUSIC_LUFS} LUFS)`);
    ff(["-y", "-i", body, "-stream_loop", "-1", "-i", MUSIC_FILE, "-filter_complex",
      `[1:a]loudnorm=I=${MUSIC_LUFS}:TP=-3:LRA=11,aresample=${AR}[mus];` +
      `[0:a]asplit=2[vk][vm];` +
      `[mus][vk]sidechaincompress=threshold=0.06:ratio=8:attack=15:release=350[musd];` +
      `[vm][musd]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.96[aout]`,
      "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", String(AR), "-movflags", "+faststart", OUT], "music");
  } else {
    console.log(`  (no music file at ${path.relative(ROOT, MUSIC_FILE)} — narration only)`);
    ff(["-y", "-i", body, "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", String(AR), "-movflags", "+faststart", OUT], "final");
  }
  console.log(`\n✓ Final → ${path.relative(ROOT, OUT)}  (${probe(OUT).toFixed(1)}s, ${AR / 1000}kHz)\n`);
}

try { main(); } catch (e) { console.error(`\n✗ ${e.message}\n`); process.exit(1); }
