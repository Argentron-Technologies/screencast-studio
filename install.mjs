#!/usr/bin/env node
/**
 * screencast-studio installer — one implementation, every platform.
 *
 *   Windows   powershell -c "irm https://raw.githubusercontent.com/Argentron-Technologies/screencast-studio/main/install.ps1 | iex"
 *   macOS     curl -fsSL https://raw.githubusercontent.com/Argentron-Technologies/screencast-studio/main/install.sh | bash
 *   Linux     curl -fsSL https://raw.githubusercontent.com/Argentron-Technologies/screencast-studio/main/install.sh | bash
 *   any       node install.mjs        (if you already cloned)
 *
 * The two shell scripts do nothing but check for node+git, clone, and hand over
 * to this file — so the actual logic exists once and behaves identically
 * everywhere. Nothing here needs admin/sudo, nothing is installed except this
 * repo, and nothing outside your home directory is touched. Re-run to update.
 *
 * Location override: SCS_DIR=/somewhere node install.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/Argentron-Technologies/screencast-studio.git";
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEST = process.env.SCS_DIR
  || (fs.existsSync(path.join(HERE, ".git")) ? HERE
      : WIN ? path.join(process.env.LOCALAPPDATA || os.homedir(), "screencast-studio")
            : path.join(os.homedir(), ".screencast-studio"));
const SCRIPTS = path.join(DEST, "scripts");
const q0 = (p) => (/\s/.test(p) ? `"${p}"` : p);

const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const say = (m) => console.log(`  ${m}`);
const ok = (m) => console.log(`  ${c(32, "[ok]")} ${m}`);
const warn = (m) => console.log(`  ${c(33, "[! ]")} ${m}`);
const die = (m) => { console.log(`  ${c(31, "[x ]")} ${m}`); process.exit(1); };
// No `shell: true`. With a shell, args are concatenated rather than escaped, so
// any path containing a space (very common on Windows — "H:\Video Generation\…")
// silently splits and the command returns nothing useful. It also trips Node's
// DEP0190 warning. git/ffmpeg/setx are all real executables, so none of them
// need a shell.
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const have = (cmd, args = ["--version"]) => { try { return run(cmd, args).status === 0; } catch { return false; } };

console.log(`\n${c(36, "screencast-studio")}`);
console.log("narrated product-walkthrough videos of web apps\n");
say(`platform: ${process.platform} ${process.arch}`);

// ── prerequisites ────────────────────────────────────────────────────────────
console.log("\nchecking prerequisites");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 18) die(`Node 18+ required, found v${process.versions.node}`);
ok(`node v${process.versions.node}`);

if (!have("git")) {
  die(WIN ? "git not found — winget install --id Git.Git"
          : MAC ? "git not found — xcode-select --install"
                : "git not found — apt install git (or your package manager)");
}
ok("git");

let ffOk = false, capture = "cdp";
if (have("ffmpeg", ["-version"])) {
  ffOk = true; ok("ffmpeg");
  const filters = run("ffmpeg", ["-hide_banner", "-filters"]).stdout || "";
  const encs = run("ffmpeg", ["-hide_banner", "-encoders"]).stdout || "";
  const devs = run("ffmpeg", ["-hide_banner", "-devices"]).stdout || "";

  // Screen capture: the mechanism differs per platform, and only the Windows
  // path is verified. Report honestly rather than implying parity.
  if (WIN && /ddagrab/.test(filters)) { capture = "dda"; ok("ddagrab — full-rate capture available"); }
  else if (MAC && /avfoundation/.test(devs)) { capture = "avf"; ok("avfoundation present (screen capture untested on macOS — see README)"); }
  else if (!WIN && !MAC && /x11grab/.test(devs)) { capture = "x11"; ok("x11grab present (screen capture untested on Linux — see README)"); }
  else warn("no desktop-capture backend — capture.mode stays \"cdp\" (fine for static pages, not for motion)");

  const hw = ["h264_nvenc", "h264_videotoolbox", "h264_qsv", "h264_vaapi"].filter((e) => new RegExp(e).test(encs));
  if (hw.length) ok(`hardware encoder: ${hw.join(", ")}`);
  else warn("no hardware h264 encoder — encoding falls back to CPU (slower, still fine)");
} else {
  warn(WIN ? "ffmpeg not found — winget install --id Gyan.FFmpeg"
           : MAC ? "ffmpeg not found — brew install ffmpeg"
                 : "ffmpeg not found — apt install ffmpeg");
}

// ── fetch ────────────────────────────────────────────────────────────────────
console.log("");
if (fs.existsSync(path.join(DEST, ".git"))) {
  if (DEST === HERE) {
    say(`already here: ${DEST}`);
  } else {
    say(`updating ${DEST}`);
    run("git", ["-C", DEST, "fetch", "--quiet", "origin"]);
    run("git", ["-C", DEST, "reset", "--hard", "--quiet", "origin/main"]);
  }
  ok(`at ${(run("git", ["-C", DEST, "rev-parse", "--short", "HEAD"]).stdout || "").trim()}`);
} else if (fs.existsSync(DEST)) {
  die(`${DEST} exists but is not a git clone. Move it aside, or set SCS_DIR.`);
} else {
  say(`cloning into ${DEST}`);
  const r = run("git", ["clone", "--quiet", "--depth", "1", REPO, DEST]);
  if (r.status !== 0) die(`clone failed: ${(r.stderr || "").trim().split("\n")[0]}`);
  ok(`cloned ${(run("git", ["-C", DEST, "rev-parse", "--short", "HEAD"]).stdout || "").trim()}`);
}

// ── register ─────────────────────────────────────────────────────────────────
console.log("");
if (WIN) {
  // setx writes the user environment without touching the machine scope or
  // needing admin. It truncates at 1024 chars, so PATH is appended via reg-free
  // PowerShell instead.
  run("setx", ["SCREENCAST_STUDIO", DEST], { stdio: "ignore" });
  const ps = `$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p -notlike '*${SCRIPTS}*') { [Environment]::SetEnvironmentVariable('Path', "$p;${SCRIPTS}", 'User'); 'added' } else { 'present' }`;
  const out = (run("powershell", ["-NoProfile", "-Command", ps]).stdout || "").trim();
  ok(`SCREENCAST_STUDIO = ${DEST}`);
  ok(out === "added" ? "scripts added to your user PATH (restart your shell)" : "scripts already on PATH");
} else {
  // Silently editing someone's shell profile from a piped installer is exactly
  // the behaviour that makes these things untrustworthy. Print it instead.
  say("add to your shell profile (~/.zshrc, ~/.bashrc):");
  console.log(`\n    export SCREENCAST_STUDIO="${DEST}"`);
  console.log(`    export PATH="$SCREENCAST_STUDIO/scripts:$PATH"\n`);
}

// ── register with coding agents ───────────────────────────────────────────────
// Only writes to agent config directories that already exist, and guidance
// blocks go between markers so they can be removed cleanly.
console.log("");
const skillScript = path.join(SCRIPTS, "install-skill.mjs");
if (fs.existsSync(skillScript)) {
  const detected = run(process.execPath, [skillScript, "--list"]).stdout || "";
  const found = (detected.match(/✓/g) || []).length;
  if (found) {
    run(process.execPath, [skillScript], { stdio: "inherit" });
  } else {
    say("no coding agents detected — register later with:");
    console.log(`      node ${q0(skillScript)}`);
  }
}

// ── next ─────────────────────────────────────────────────────────────────────
console.log(`\n${c(36, "next")}`);
console.log(`
  1. start a project — the wizard does keys and prerequisites in one pass
       mkdir my-videos && cd my-videos
       node ${q0(path.join(SCRIPTS, "setup.mjs"))}

  2. read the workflow
       ${path.join(DEST, "skills", "narrated-walkthrough", "SKILL.md")}
`);
say(`suggested capture.mode for this machine: ${c(36, `"${capture === "dda" ? "dda" : "cdp"}"`)}`);
if (capture === "avf" || capture === "x11") {
  warn("a desktop-capture backend exists here but only the Windows path is verified;");
  warn("start with \"cdp\" and see the README before relying on full-rate capture");
}
if (!ffOk) { console.log(""); warn("install ffmpeg before step 3, or nothing will render"); }
console.log("");
