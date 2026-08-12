#!/usr/bin/env node
/**
 * setup.mjs — interactive wizard: prerequisites, API keys, project scaffold,
 * all in one pass, with every key verified against the live service before it
 * is written.
 *
 *   node setup.mjs              in an empty (or existing) project directory
 *   node setup.mjs --no-verify  skip the live key checks
 *   node setup.mjs --dir PATH   set up that directory instead of the cwd
 *
 * Why verify: a mistyped key does not fail here, it fails ten minutes into
 * generating a voice-over. Both checks are free — listing voices, listing
 * models — so there is no reason not to.
 *
 * Re-running is safe. Existing .env values are offered as defaults and kept if
 * you press enter; any key this wizard does not manage is preserved.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

const argv = process.argv.slice(2);
const argOf = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const NO_VERIFY = argv.includes("--no-verify");
const ROOT = path.resolve(argOf("--dir", process.cwd()));
fs.mkdirSync(ROOT, { recursive: true });

const ESC = String.fromCharCode(27);
const tty = process.stdout.isTTY;
const col = (n, s) => (tty ? `${ESC}[${n}m${s}${ESC}[0m` : s);
const bold = (s) => col(1, s);
const dim = (s) => col(2, s);
const cyan = (s) => col(36, s);
const ok = (m) => console.log(`  ${col(32, "OK")} ${m}`);
const warn = (m) => console.log(`  ${col(33, " !")} ${m}`);
const bad = (m) => console.log(`  ${col(31, " x")} ${m}`);
const step = (n, m) => console.log(`\n${cyan("-- " + n)} ${bold(m)}`);

// ── terminal ─────────────────────────────────────────────────────────────────
// A piped installer (curl ... | sh) has already consumed stdin, so reading it
// would hit EOF and silently accept every default — an empty .env that looks
// like it worked. The terminal is still reachable directly, so reopen it:
// /dev/tty on Unix, CONIN$ on Windows. Give up only if there truly isn't one.
function openTerminal() {
  if (process.stdin.isTTY) return process.stdin;
  try {
    const fd = fs.openSync(WIN ? "CONIN$" : "/dev/tty", "r");
    const s = fs.createReadStream(null, { fd, autoClose: false });
    s.isTTY = true;
    s.setRawMode = (on) => { try { process.stdin.setRawMode(on); } catch { /* not a tty */ } };
    return s;
  } catch {
    return null;
  }
}
const input = openTerminal();
if (!input) {
  console.error(`\n  This wizard needs a terminal, and none is attached.`);
  console.error(`  Run it directly:  node ${path.join(HERE, "setup.mjs")}\n`);
  process.exit(1);
}
const rl = readline.createInterface({ input, output: process.stdout });

const ask = (q, def = "") =>
  new Promise((res) =>
    rl.question(def ? `  ${q} ${dim("[" + def + "]")} ` : `  ${q} `, (a) => res((a || "").trim() || def)));

const yes = async (q, def = true) => {
  const a = (await ask(`${q} ${dim(def ? "[Y/n]" : "[y/N]")}`)).toLowerCase();
  return a === "" ? def : a.startsWith("y");
};

// Secrets echo as dots. An existing value shows only its last 4 characters, so
// you can tell which key is which without putting it on screen or in scrollback.
const CTRL_C = String.fromCharCode(3);
const DEL = String.fromCharCode(127);
const BS = String.fromCharCode(8);
function askSecret(q, existing = "") {
  const hint = existing ? dim(` [keep ....${existing.slice(-4)}]`) : "";
  return new Promise((res) => {
    let buf = "";
    const finish = (v) => {
      input.removeListener("data", onData);
      try { input.setRawMode(false); } catch { /* ignore */ }
      process.stdout.write("\n");
      rl.resume();
      res(v);
    };
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      if (s === "\r" || s === "\n") return finish(buf || existing);
      if (s === CTRL_C) { process.stdout.write("\n"); process.exit(130); }
      if (s === DEL || s === BS) {
        if (buf) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); }
        return;
      }
      buf += s;
      process.stdout.write("*");
    };
    rl.pause();
    process.stdout.write(`  ${q}${hint} `);
    try { input.setRawMode(true); } catch { /* ignore */ }
    input.resume();
    input.on("data", onData);
  });
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const have = (cmd, args = ["--version"]) => { try { return run(cmd, args).status === 0; } catch { return false; } };
const runLive = (cmd, args, opts = {}) =>
  new Promise((res) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
    p.on("close", (code) => res(code === 0));
    p.on("error", () => res(false));
  });
const npm = WIN ? "npm.cmd" : "npm";
const npx = WIN ? "npx.cmd" : "npx";

console.log(`\n${cyan("screencast-studio")} ${dim("setup")}`);
console.log(dim(`  project: ${ROOT}`));

// ── 1. prerequisites ─────────────────────────────────────────────────────────
step(1, "prerequisites");

if (Number(process.versions.node.split(".")[0]) < 18) {
  bad(`Node 18+ required, found v${process.versions.node}`);
  process.exit(1);
}
ok(`node v${process.versions.node}`);

let ffOk = have("ffmpeg", ["-version"]);
if (ffOk) {
  ok("ffmpeg");
} else {
  warn("ffmpeg not found - nothing can be rendered without it");
  const mgr = WIN
    ? { cmd: "winget", args: ["install", "--id", "Gyan.FFmpeg", "--accept-source-agreements", "--accept-package-agreements"] }
    : MAC
      ? { cmd: "brew", args: ["install", "ffmpeg"] }
      : null;
  if (mgr && have(mgr.cmd, ["--version"]) && (await yes(`install it now with ${mgr.cmd}?`))) {
    ffOk = await runLive(mgr.cmd, mgr.args);
    if (ffOk) ok("ffmpeg installed (restart your shell if it is still not found)");
    else bad("install failed - do it manually");
  } else {
    console.log(dim(`     ${WIN ? "winget install --id Gyan.FFmpeg" : MAC ? "brew install ffmpeg" : "apt install ffmpeg   (or your package manager)"}`));
  }
}

// Playwright must live in the PROJECT: the scripts resolve it from there first,
// and a global install will not be found.
let pwOk = fs.existsSync(path.join(ROOT, "node_modules", "playwright"));
if (pwOk) {
  ok("playwright (project-local)");
} else {
  warn("playwright not installed in this project");
  if (await yes("install playwright + chromium now?")) {
    if (!fs.existsSync(path.join(ROOT, "package.json"))) await runLive(npm, ["init", "-y"]);
    pwOk = await runLive(npm, ["install", "--save-dev", "playwright"]);
    if (pwOk) pwOk = await runLive(npx, ["playwright", "install", "chromium"]);
    if (pwOk) ok("playwright ready");
    else bad("install failed - run: npm i -D playwright && npx playwright install chromium");
  }
}

// ── 2. credentials ───────────────────────────────────────────────────────────
step(2, "credentials");
console.log(dim("  Stored in .env, which is gitignored. Press enter to keep an existing value."));

const ENV_PATH = path.join(ROOT, ".env");
const env = {};
const seen = [];
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) { env[m[1]] = m[2].replace(/^["']|["']$/g, ""); seen.push(m[1]); }
  }
  ok(`found existing .env (${seen.length} keys)`);
}

async function verifyCloudTTS(key) {
  if (!key || NO_VERIFY) return null;
  try {
    const r = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(key)}`);
    if (r.ok) {
      const n = ((await r.json()).voices || []).length;
      return { ok: true, msg: `${n} voices available` };
    }
    const e = await r.json().catch(() => ({}));
    const msg = e && e.error && e.error.message ? e.error.message : `HTTP ${r.status}`;
    return { ok: false, msg: msg.slice(0, 90) };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

async function verifyOpenAI(key) {
  if (!key || NO_VERIFY) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (r.ok) return { ok: true, msg: "authenticated" };
    const e = await r.json().catch(() => ({}));
    const msg = e && e.error && e.error.message ? e.error.message : `HTTP ${r.status}`;
    return { ok: false, msg: msg.slice(0, 90) };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

async function collect(name, label, hint, verifier) {
  console.log(`\n  ${bold(label)}`);
  if (hint) console.log(dim(`  ${hint}`));
  for (;;) {
    const v = await askSecret(`${name}:`, env[name] || "");
    if (!v) { warn("skipped - you can add it to .env later"); return ""; }
    const res = verifier ? await verifier(v) : null;
    if (!res) { ok("saved (not verified)"); return v; }
    if (res.ok) { ok(res.msg); return v; }
    bad(res.msg);
    if (!(await yes("try again?", true))) return v;
  }
}

env.CLOUDTTS_API_KEY = await collect(
  "CLOUDTTS_API_KEY",
  "Google Cloud Text-to-Speech - the narration voice",
  "console.cloud.google.com -> enable Text-to-Speech API -> Credentials -> API key",
  verifyCloudTTS
);

env.OPENAI_API_KEY = await collect(
  "OPENAI_API_KEY",
  "OpenAI - word-level transcription for cue timing and sync checks",
  "platform.openai.com/api-keys",
  verifyOpenAI
);

console.log(`\n  ${bold("Your app")}`);
env.APP_URL = await ask("APP_URL (e.g. https://app.example.com):", env.APP_URL || "");
console.log(dim("  Optional: with these the recorder can sign itself back in mid-run,"));
console.log(dim("  which matters when a session is shorter than a full take."));
env.APP_EMAIL = await ask("APP_EMAIL (blank to log in manually):", env.APP_EMAIL || "");
if (env.APP_EMAIL) env.APP_PASSWORD = await askSecret("APP_PASSWORD:", env.APP_PASSWORD || "");
if (!env.CLOUDTTS_VOICE) env.CLOUDTTS_VOICE = "en-US-Chirp3-HD-Achird";

// ── 3. write .env ────────────────────────────────────────────────────────────
step(3, "writing .env");
const MANAGED = ["APP_URL", "APP_EMAIL", "APP_PASSWORD", "CLOUDTTS_API_KEY", "CLOUDTTS_VOICE", "OPENAI_API_KEY"];
const out = [
  "# screencast-studio - secrets. NEVER commit this file.",
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
// Carry across anything this wizard does not manage, so a hand-added key is not
// silently dropped when the wizard is re-run.
const extra = seen.filter((k) => !MANAGED.includes(k));
if (extra.length) {
  out.push("# preserved from your previous .env");
  for (const k of extra) out.push(`${k}=${env[k]}`);
  out.push("");
}
fs.writeFileSync(ENV_PATH, out.join("\n"));
if (!WIN) { try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* best effort */ } }
ok(`.env written${WIN ? "" : " (mode 600)"}`);

const GI = path.join(ROOT, ".gitignore");
const gi = fs.existsSync(GI) ? fs.readFileSync(GI, "utf8") : "";
if (!/^\.env\s*$/m.test(gi)) {
  fs.writeFileSync(GI, (gi ? gi.replace(/\s*$/, "\n") : "") + "\n# secrets and sessions\n.env\n.auth/\n");
  ok(".env added to .gitignore");
} else {
  ok(".env already gitignored");
}

// ── 4. project files ─────────────────────────────────────────────────────────
step(4, "project files");
if (fs.existsSync(path.join(ROOT, "walkthrough.config.mjs"))) {
  ok("walkthrough.config.mjs exists - left alone");
} else {
  const mod = await ask("module name (one video):", "tour");
  await runLive(process.execPath, [path.join(HERE, "init.mjs"), "--module", mod]);
}

// ── 5. capture check ─────────────────────────────────────────────────────────
step(5, "capture check");
const wantDoctor = ffOk && (await yes("run doctor.mjs to check this machine can capture smoothly?", true));
rl.close();
if (wantDoctor) await runLive(process.execPath, [path.join(HERE, "doctor.mjs")]);

console.log(`\n${cyan("done")}`);
console.log(`
  1. edit ${bold("walkthrough.config.mjs")} - selectors and scenes for your app
  2. write the narration in ${bold("content/<module>.script.json")}
  3. sign in once:   node ${path.join(HERE, "record.mjs")} --login
  4. the full loop:  ${path.join(PLUGIN, "skills", "narrated-walkthrough", "SKILL.md")}
`);
process.exit(0);
