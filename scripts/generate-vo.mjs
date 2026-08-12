#!/usr/bin/env node
/**
 * generate-vo-cloudtts.mjs — VO via Google Cloud Text-to-Speech (Chirp 3 HD),
 * with sentence cues recovered by an OpenAI Whisper alignment pass. Drop-in
 * sibling of the gemini / edge / elevenlabs / openai generators (same manifest).
 *
 *   node scripts/generate-vo-cloudtts.mjs --script content/leads.script.json --out vo/leads
 *
 * Chirp 3 HD = the production Cloud TTS release of the Gemini-TTS voice set
 * (Achird, Alnilam, …). No style prompt, but no 100/day cap and 1M chars/month
 * free. We request lossless LINEAR16 (WAV) and encode mp3 192k locally.
 *
 * Env (.env supported):
 *   CLOUDTTS_API_KEY (required)        OPENAI_API_KEY (required for alignment)
 *   CLOUDTTS_VOICE   (default en-US-Chirp3-HD-Achird; languageCode derived from the name)
 *   CLOUDTTS_RATE    (optional speakingRate, e.g. 0.95)
 *   OPENAI_ALIGN_MODEL (default whisper-1)
 *   VO_FPS / VO_TAIL_GAP_SECONDS / FFMPEG / FFPROBE
 * Flags: --force  --scene <id>  --list  --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

(function loadEnv() {
  const p = path.join(ROOT, ".env"); if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("="); if (i < 0) continue;
    const k = l.slice(0, i).trim(); let v = l.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argValue = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : undefined; };
const SCRIPT_PATH = path.resolve(ROOT, argValue("--script") || path.join("content", "tour.script.json"));
const PUBLIC_PREFIX = (argValue("--out") || "vo/tour").replace(/^\/+|\/+$/g, "");
const OUT_DIR = path.join(ROOT, "public", ...PUBLIC_PREFIX.split("/"));
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const FORCE = has("--force"); const DRY = has("--dry-run"); const LIST = has("--list");
const onlyScenes = args.reduce((a, x, i) => (x === "--scene" && args[i + 1] ? [...a, args[i + 1]] : a), []);

const TTS_KEY = process.env.CLOUDTTS_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOICE = process.env.CLOUDTTS_VOICE || "en-US-Chirp3-HD-Achird";
const LANG_CODE = VOICE.split("-").slice(0, 2).join("-");      // en-US-Chirp3-HD-Achird → en-US
const RATE = process.env.CLOUDTTS_RATE ? Number(process.env.CLOUDTTS_RATE) : null;
const ALIGN_MODEL = process.env.OPENAI_ALIGN_MODEL || "whisper-1";
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";

const script = JSON.parse(fs.readFileSync(SCRIPT_PATH, "utf8"));
const FPS = process.env.VO_FPS ? Number(process.env.VO_FPS) : script.meta?.fps ?? 30;
const TAIL_PAD_FRAMES = Math.round((process.env.VO_TAIL_GAP_SECONDS ? Number(process.env.VO_TAIL_GAP_SECONDS) : 0.5) * FPS);
const scenes = Array.isArray(script.scenes) ? script.scenes : [];
const sha1 = (t) => crypto.createHash("sha1").update(t).digest("hex").slice(0, 12);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const r3 = (n) => Math.round(n * 1000) / 1000;
const probeSeconds = (f) => parseFloat((spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", f], { encoding: "utf8" }).stdout || "").trim()) || 0;

// Cloud TTS → LINEAR16 wav (lossless) → ffmpeg mp3 192k.
async function ttsChirp(text, mp3Path) {
  const body = {
    input: { text },
    voice: { languageCode: LANG_CODE, name: VOICE },
    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 48000, ...(RATE ? { speakingRate: RATE } : {}) },
  };
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${TTS_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Cloud TTS ${res.status} ${res.statusText}\n${(await res.text().catch(() => "")).slice(0, 300)}`);
  const j = await res.json();
  if (!j.audioContent) throw new Error(`Cloud TTS returned no audio: ${JSON.stringify(j).slice(0, 300)}`);
  const wav = Buffer.from(j.audioContent, "base64");   // LINEAR16 comes with a WAV header
  const r = spawnSync(FFMPEG, ["-y", "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", "192k", mp3Path], { input: wav, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg wav→mp3 failed: ${(r.stderr || "").toString().slice(-300)}`);
}

// Whisper word timestamps → map onto the narration's sentences.
async function align(mp3Buf, text) {
  const fd = new FormData();
  fd.append("file", new Blob([mp3Buf], { type: "audio/mpeg" }), "audio.mp3");
  fd.append("model", ALIGN_MODEL);
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "word");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: fd });
  if (!res.ok) throw new Error(`align ${res.status} ${res.statusText}\n${(await res.text().catch(() => "")).slice(0, 200)}`);
  const words = (await res.json()).words || [];
  const sentences = text.match(/[^.!?।]+[.!?।]+|\S[^.!?।]*$/g) || [text];
  const cues = []; let wi = 0;
  for (const sent of sentences) {
    const n = (sent.trim().match(/\S+/g) || []).length; if (!n) continue;
    const slice = words.slice(wi, wi + n); wi += n;
    if (slice.length) cues.push({ start: r3(slice[0].start), end: r3(slice[slice.length - 1].end), text: sent.trim() });
  }
  return cues;
}

if (LIST) { console.log(`\n${scenes.length} scenes:\n`); for (const s of scenes) console.log(`  ${s.id.padEnd(16)} ${String((s.narration || "").length).padStart(4)} chars`); process.exit(0); }

async function main() {
  if (!DRY) { if (!TTS_KEY) throw new Error("CLOUDTTS_API_KEY not set (.env)."); if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set (needed for Whisper alignment)."); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) : {};
  manifest.scenes = manifest.scenes && typeof manifest.scenes === "object" ? manifest.scenes : {};
  const targets = onlyScenes.length ? scenes.filter((s) => onlyScenes.includes(s.id)) : scenes;

  console.log(`\nChirp3-HD VO — voice=${VOICE} align=${ALIGN_MODEL} fps=${FPS}${DRY ? "  (dry)" : ""}${FORCE ? "  (force)" : ""}\n`);
  let generated = 0, skipped = 0;
  for (const s of targets) {
    const text = (s.narration || "").trim();
    const hash = sha1(`chirp3hd|${VOICE}|${RATE ?? ""}|${text}`);
    const file = path.join(OUT_DIR, `${s.id}.mp3`);
    const rel = `${PUBLIC_PREFIX}/${s.id}.mp3`;
    const existing = manifest.scenes[s.id];
    const upToDate = !FORCE && existing && existing.hash === hash && fs.existsSync(file);
    if (DRY) { console.log(`  ${upToDate ? "skip" : "gen "}  ${s.id.padEnd(16)} ${String(text.length).padStart(4)} chars`); continue; }
    if (upToDate) { console.log(`  skip  ${s.id.padEnd(16)} (unchanged, ${fmt(existing.seconds)})`); skipped++; continue; }

    process.stdout.write(`  gen   ${s.id.padEnd(16)} … tts`);
    await ttsChirp(text, file);
    const audio = fs.readFileSync(file);
    process.stdout.write(" align");
    const cues = await align(audio, text).catch((e) => { console.log(`\n    ⚠ align failed (${e.message}); empty cues`); return []; });
    const seconds = probeSeconds(file);
    const durationInFrames = Math.ceil(seconds * FPS) + TAIL_PAD_FRAMES;
    manifest.scenes[s.id] = { file: rel, seconds: r3(seconds), durationInFrames, hash, chars: text.length, cues };
    console.log(` → ${seconds.toFixed(1)}s, ${cues.length} cues`);
    generated++;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (DRY) { console.log("\nDry run — nothing written.\n"); return; }
  for (const id of Object.keys(manifest.scenes)) if (!scenes.some((s) => s.id === id)) delete manifest.scenes[id];
  manifest.engine = "cloudtts-chirp3hd"; manifest.voice = VOICE; manifest.fps = FPS; manifest.generatedAt = new Date().toISOString();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  const total = scenes.reduce((sum, s) => sum + (manifest.scenes[s.id]?.durationInFrames ?? Math.round((s.fallbackSeconds || 5) * FPS)), 0);
  console.log(`\n✓ ${generated} generated, ${skipped} unchanged. Manifest → ${path.relative(ROOT, MANIFEST_PATH)}`);
  console.log(`  Approx length: ${fmt(total / FPS)} (${total}f @ ${FPS}fps)\n`);
}
main().catch((e) => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
