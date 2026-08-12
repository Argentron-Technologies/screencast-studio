#!/usr/bin/env node
/**
 * setup.mjs — interactive wizard: prerequisites, API keys, project scaffold,
 * all in one pass, with every key verified against the live service before it
 * is written.
 *
 *   node setup.mjs              in an empty (or existing) project directory
 *   node setup.mjs --no-verify  skip the live key checks
 *
 * Why verify: a mistyped key does not fail here, it fails ten minutes into
 * generating a voice-over. Both checks used are free — listing voices and
 * listing models — so there is no reason not to.
 *
 * Re-running is safe. Existing .env values are offered as defaults and kept if
 * you press enter; nothing already correct is overwritten.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const ROOT = process.cwd();
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const NO_VERIFY = process.argv.includes("--no-verify");

const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s), dim = (s) => c(2, s), cyan = (s) => c(36, s);
const ok = (m) => console.log(`  ${c(32, "✓")} ${m}`);
const warn = (m) => console.log(`  ${c(33, "!")} ${m}`);
const bad = (m) => console.log(`  ${c(31, "✗")} ${m}`);
const step = (n, m) => console.log(`\n${cyan(`── ${n} ${"─".repeat(Math.max(0, 56 - m.length - String(n).length))}`)} ${bold(m)}`);

// ── input ────────────────────────────────────────────────────────────────────
// A piped installer (curl | sh) has already consumed stdin, so prompts would
// read EOF and silently take every default. Refuse rather than misbehave.
if (!process.stdin.isTTY) {
  console.error(`\n  This wizard needs an interactive terminal.\n  Run it directly:  node ${path.relative(ROOT, path.join(HERE, "setup.mjs")) || "setup.mjs"}\n`);
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = "") =>
  new Promise((res) => rl.question(def ? `  ${q} ${dim(`[${def}]`)} ` : `  ${q} `, (a) => res((a || "").trim() || def)));
const yes = async (q, def = true) => {
  const a = (await ask(`${q} ${dim(def ? "[Y/n]" : "[y/N]")}`)).toLowerCase();
  return a === "" ? def : a.startsWith("y");
};
// Secrets are echoed as dots. Existing values show only their last 4 chars, so
// you can tell which key is which without exposing it on screen or in scrollback.
function askSecret(q, existing = "") {
  const hint = existing ? dim(` [keep ••••${existing.slice(-4)}]`) : "";
  return new Promise((res) => {
    const prompt = `  ${q}${hint} `;
    let buf = "";
    const onData = (ch) => {
      const s = ch.toString("utf8");
      if (s === "\r" || s === "\n") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        rl.resume();
        res(buf || existing);
      } else if (s === "") { process.stdout.write("\n"); process.exit(130); }
      else if (s === "" || s === "") { if (buf) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); } }
      else { buf += s; process.stdout.write("•"); }
    };
    rl.pause();
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const have = (cmd, args = ["--version"]) => { try { return run(cmd, args).status === 0; } catch { return false; } };
const runLive = (cmd, args) => new Promise((res) => {
  const p = spawn(cmd, args, { stdio: "inherit", shell: false });
  p.on("close", (code) => res(code === 0));
  p.on("error", () => res(false));
});

console.log(`\n${cyan("screencast-studio")} ${dim("setup")}`);
console.log(dim(`  project: ${ROOT}`));

// ── 1. prerequisites ─────────────────────────────────────────────────────────
step(1, "prerequisites");

if (Number(process.versions.node.split(".")[0]) < 18) { bad(`Node 18+ required, found v${process.versions.node}`); process.exit(1); }
ok(`node v${process.versions.node}`);

let ffOk = have("ffmpeg", ["-version"]);
if (ffOk) ok("ffmpeg");
else {
  warn("ffmpeg not found — nothing can be rendered without it");
  const cmd = WIN ? ["winget", ["install", "--id", "Gyan.FFmpeg", "--accept-source-agreements", "--accept-package-agreements"]]
    : MAC ? ["brew", ["install", "ffmpeg"]] : null;
  if (cmd && have(cmd[0], WIN ? ["--version"] : ["--version"]) && await yes(`install it now with ${cmd[0]}?`)) {
    ffOk = await runLive(cmd[0], cmd[1]);
    ffOk ? ok("ffmpeg installed (restart your shell if it is still not found)") : bad("install failed — do it manually");
  } else {
    console.log(dim(`     ${WIN ? "winget install --id Gyan.FFmpeg" : MAC ? "brew install ffmpeg" : "apt install ffmpeg   (or your package manager)"}`));
  }
}

// Playwright must live in the PROJECT, not the plugin — the scripts resolve it
// from the project first, and a global install will not be found.
let pwOk = fs.existsSync(path.join(ROOT, "node_modules", "playwright"));
if (pwOk) ok("playwright (project-local)");
else {
  warn("playwright not installed in this project");
  if (await yes("install playwright + chromium now?")) {
    if (!fs.existsSync(path.join(ROOT, "package.json"))) {
      await runLive(WIN ? "npm.cmd" : "npm", ["init", "-y"]);
    }
    pwOk = await runLive(WIN ? "npm.cmd" : "npm", ["install", "--save-dev", "playwright"]);
    if (pwOk) pwOk = await runLive(WIN ? "npx.cmd" : "npx", ["playwright", "install", "chromium"]);
    pwOk ? ok("playwright ready") : bad("install failed — run: npm i -D playwright && npx playwright install chromium");
  }
}

// ── 2. keys ──────────────────────────────────────────────────────────────────
step(2, "credentials");
console.log(dim("  Stored in .env, which is gitignored. Press enter to keep an existing value."));

const ENV_PATH = path.join(ROOT, ".env");
const env = {};
const order = [];
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) { env[m[1]] = m[2].replace(/^["']|["']$/g, ""); order.push(m[1]); }
  }
  ok(`found existing .env (${order.length} keys)`);
}

async function verifyCloudTTS(key) {
  if (!key || NO_VERIFY) return null;
  try {
    const r = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(key)}`);
    if (r.ok) { const n = ((await r.json()).voices || []).length; return { ok: true, msg: `${n} voices available` }; }
    const e = await r.json().catch(() => ({}));
    return { ok: false, msg: e?.error?.message?.slice(0, 90) || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, msg: e.message }; }
}
async function verifyOpenAI(key) {
  if (!key || NO_VERIFY) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (r.ok) return { ok: true, msg: "authenticated" };
    const e = await r.json().catch(() => ({}));
    return { ok: false, msg: e?.error?.message?.slice(0, 90) || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, msg: e.message }; }
}

async function collect(name, label, hint, verifier) {
  console.log(`\n  ${bold(label)}`);
  if (hint) console.log(dim(`  ${hint}`));
  for (;;) {
    const v = await askSecret(`${name}:`, env[name] || "");
    if (!v) { warn("skipped — you can add it to .env later"); return ""; }
    const res = verifier ? await verifier(v) : null;
    if (!res) { ok("saved (not verified)"); return v; }
    if (res.ok) { ok(res.msg); return v; }
    bad(res.msg);
    if (!(await yes("try again?", true))) return v;
  }
}

env.CLOUDTTS_API_KEY = await collect(
  "CLOUDTTS_API_KEY", "Google Cloud Text-to-Speech — the narration voice",
  "console.cloud.google.com → enable Text-to-Speech API → Credentials → API key", verifyCloudTTS);

env.OPENAI_API_KEY = await collect(
  "OPENAI_API_KEY", "OpenAI — word-level transcription for cue timing and sync checks",
  "platform.openai.com/api-keys", verifyOpenAI);

console.log(`\n  ${bold("Your app")}`);
env.APP_URL = await ask("APP_URL (e.g. https://app.example.com):", env.APP_URL || "");
console.log(dim("  Optional: with these the recorder can sign itself back in mid-run,"));
console.log(dim("  which matters when a session is shorter than a full take."));
env.APP_EMAIL = await ask("APP_EMAIL (blank to log in manually):", env.APP_EMAIL || "");
if (env.APP_EMAIL) env.APP_PASSWORD = await askSecret("APP_PASSWORD:", env.APP_PASSWORD || "");

if (!env.CLOUDTTS_VOICE) env.CLOUDTTS_VOICE = "en-US-Chirp3-HD-Achird";

// ── 3. write .env ────────────────────────────────────────────────────────────
step(3, "writing .env");
const lines = [
  "# screencast-studio — secrets. NEVER commit this file.",
  `# written by setup.mjs on ${new Date().toISOString().slice(0, 10)}`,
  "",
  "# the app under test",
  `APP_URL=${env.APP_URL || ""}`,
  `APP_EMAIL=${env.APP_EMAIL || ""}`,
  `APP_PASSWORD=${env.APP_PASSWORD || ""}`,
  "",
  "# voice-over",
  `CLOUDTTS_API_KEY=${env.CLOUDTTS_API_KEY || ""}`,
  `CLOUDTTS_VOICE=${env.CLOUDTTS_VOICE}`,
  "",
  "# word-level transcription (cue timing + verify-sync)",
  `OPENAI_API_KEY=${env.OPENAI_API_KEY || ""}`,
  "",
];
// Carry across anything the wizard does not manage, so a hand-added key is not
// silently dropped on re-run.
const managed = new Set(["APP_URL", "APP_EMAIL", "APP_PASSWORD", "CLOUDTTS_API_KEY", "CLOUDTTS_VOICE", "OPENAI_API_KEY"]);
const extra = order.filter((k) => !managed.has(k));
if (extra.length) { lines.push("# preserved from your previous .env"); for (const k of extra) lines.push(`${k}=${env[k]}`); lines.push(""); }
fs.writeFileSync(ENV_PATH, lines.join("\n"));
if (!WIN) { try { fs.chmodSync(ENV_PATH, 0o600); } catch {} }
ok(`.env written${WIN ? "" : " (mode 600)"}`);

const GI = path.join(ROOT, ".gitignore");
const gi = fs.existsSync(GI) ? fs.readFileSync(GI, "utf8") : "";
if (!/^\.env\s*$/m.test(gi)) {
  fs.writeFileSync(GI, (gi ? gi.replace(/\s*$/, "\n") : "") + "\n# secrets and sessions\n.env\n.auth/\n");
  ok(".env added to .gitignore");
} else ok(".env already gitignored");

// ── 4. scaffold ──────────────────────────────────────────────────────────────
step(4, "project files");
if (fs.existsSync(path.join(ROOT, "walkthrough.config.mjs"))) ok("walkthrough.config.mjs exists — left alone");
else {
  const mod = await ask("module name (one video):", "tour");
  await runLive(process.execPath, [path.join(HERE, "init.mjs"), "--module", mod]);
}

// ── 5. check ─────────────────────────────────────────────────────────────────
step(5, "capture check");
if (ffOk && await yes("run doctor.mjs to check this machine can capture smoothly?", true)) {
  rl.close();
  await runLive(process.execPath, [path.join(HERE, "doctor.mjs")]);
} else rl.close();

console.log(`\n${cyan("done")}`);
console.log(`
  1. edit ${bold("walkthrough.config.mjs")} — selectors and scenes for your app
  2. write the narration in ${bold("content/<module>.script.json")}
  3. sign in once:   node ${path.join(HERE, "record.mjs")} --login
  4. then follow the loop in ${path.join(PLUGIN, "skills", "narrated-walkthrough", "SKILL.md")}
`);
