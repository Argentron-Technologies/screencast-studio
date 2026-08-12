#!/usr/bin/env node
/**
 * install-skill.mjs — register the walkthrough workflow with the coding agents
 * installed on this machine.
 *
 *   node install-skill.mjs            install into every agent detected
 *   node install-skill.mjs --list     show what was detected, change nothing
 *   node install-skill.mjs --remove   undo
 *
 * BE CLEAR ABOUT WHAT "SKILL" MEANS PER AGENT. Only Claude Code has a
 * first-class skills format (a SKILL.md with frontmatter, auto-loaded when the
 * task matches). The others take persistent instructions through an
 * agent-guidance file. So:
 *
 *   Claude Code   → ~/.claude/skills/narrated-walkthrough/SKILL.md   (real skill)
 *   Codex         → ~/.codex/AGENTS.md                               (guidance block)
 *   OpenCode      → ~/.config/opencode/AGENTS.md                     (guidance block)
 *   Crush         → ~/.config/crush/CRUSH.md                         (guidance block)
 *
 * Guidance blocks are written between markers so they can be updated or
 * removed without touching anything else in the file, and nothing is installed
 * for an agent whose config directory does not already exist.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const SKILL_SRC = path.join(PLUGIN, "skills", "narrated-walkthrough");
const HOME = os.homedir();
const LIST = process.argv.includes("--list");
const REMOVE = process.argv.includes("--remove");

const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const ok = (m) => console.log(`  ${c(32, "✓")} ${m}`);
const skip = (m) => console.log(`  ${c(90, "·")} ${c(90, m)}`);
const warn = (m) => console.log(`  ${c(33, "!")} ${m}`);

const BEGIN = "<!-- BEGIN screencast-studio -->";
const END = "<!-- END screencast-studio -->";

const firstDir = (...cands) => cands.find((p) => p && fs.existsSync(p));

// A compact pointer, not a copy of the skill: the full workflow stays in one
// place so it cannot drift between four installed copies.
const guidance = () => `${BEGIN}
## Narrated walkthrough videos (screencast-studio)

When asked to make a **tutorial video, product demo, screencast, launch video,
feature walkthrough or build-in-public video of a web app**, use the
screencast-studio pipeline instead of improvising screen recording.

Installed at: \`${PLUGIN}\`

Read \`${path.join(PLUGIN, "skills", "narrated-walkthrough", "SKILL.md")}\` first —
it has the full workflow and the failure modes that are not obvious.

The short version: the voice-over is generated FIRST and transcribed to
per-sentence timings, then the browser is driven against those timings, so
actions land on the sentence that describes them.

\`\`\`bash
S="${path.join(PLUGIN, "scripts")}"
node $S/setup.mjs                       # keys + prerequisites, once per project
node $S/record.mjs --login              # sign in, once
node $S/generate-vo.mjs --script content/<m>.script.json --out vo/<m>
node $S/normalize-vo.mjs --script content/<m>.script.json --out vo/<m>
node $S/refresh-durations.mjs --out vo/<m>
MODULE=<m> node $S/check-cues.mjs       # ALWAYS before recording
MODULE=<m> node $S/verify-selectors.mjs # ALWAYS before recording
MODULE=<m> node $S/record.mjs
node $S/stitch.mjs                      # see SKILL.md for the env vars
MODULE=<m> node $S/verify-sync.mjs      # proves A/V sync, emits chapters
\`\`\`

Three rules worth remembering even without opening the file: put page-load waits
at the END of the previous scene (never the start of the next, or narration
plays over a blank page); \`cueIdx\` must be less than the scene's cue count,
which is not always its sentence count; and run \`doctor.mjs\` before a long take,
because "the video is jerky" has three distinct causes with three distinct fixes.
${END}`;

// agent → where its persistent guidance file lives
const AGENTS = [
  {
    name: "Claude Code",
    kind: "skill",
    dir: firstDir(path.join(HOME, ".claude")),
    target: path.join(HOME, ".claude", "skills", "narrated-walkthrough"),
  },
  {
    name: "Codex",
    kind: "guidance",
    dir: firstDir(path.join(HOME, ".codex")),
    target: path.join(HOME, ".codex", "AGENTS.md"),
  },
  {
    name: "OpenCode",
    kind: "guidance",
    dir: firstDir(path.join(HOME, ".config", "opencode"), path.join(process.env.APPDATA || "", "opencode")),
    targetIn: "AGENTS.md",
  },
  {
    name: "Crush",
    kind: "guidance",
    dir: firstDir(path.join(HOME, ".config", "crush"), path.join(process.env.APPDATA || "", "crush"), path.join(HOME, ".crush")),
    targetIn: "CRUSH.md",
  },
];

function upsertBlock(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, "m");
  if (re.test(cur)) cur = cur.replace(re, body + "\n");
  else cur = (cur.trimEnd() + (cur.trim() ? "\n\n" : "")) + body + "\n";
  fs.writeFileSync(file, cur);
}
function removeBlock(file) {
  if (!fs.existsSync(file)) return false;
  const cur = fs.readFileSync(file, "utf8");
  const re = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`, "m");
  if (!re.test(cur)) return false;
  fs.writeFileSync(file, cur.replace(re, "\n").replace(/\n{3,}/g, "\n\n").trimStart());
  return true;
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

console.log(`\n${c(36, "screencast-studio")} ${c(2, REMOVE ? "— removing agent integrations" : "— agent integrations")}\n`);

let done = 0;
for (const a of AGENTS) {
  if (!a.dir) { skip(`${a.name.padEnd(12)} not installed`); continue; }
  const target = a.target || path.join(a.dir, a.targetIn);

  if (LIST) { ok(`${a.name.padEnd(12)} → ${target}`); done++; continue; }

  if (REMOVE) {
    if (a.kind === "skill") {
      if (fs.existsSync(target)) { fs.rmSync(target, { recursive: true, force: true }); ok(`${a.name.padEnd(12)} removed ${target}`); done++; }
      else skip(`${a.name.padEnd(12)} nothing to remove`);
    } else {
      removeBlock(target) ? (ok(`${a.name.padEnd(12)} block removed from ${target}`), done++) : skip(`${a.name.padEnd(12)} no block found`);
    }
    continue;
  }

  if (a.kind === "skill") {
    // Copy rather than symlink: symlinks need Developer Mode or elevation on
    // Windows, and a broken link is a worse failure than a stale copy.
    fs.rmSync(target, { recursive: true, force: true });
    copyDir(SKILL_SRC, target);
    // Point the copy back at the install so the agent can find the scripts.
    const f = path.join(target, "SKILL.md");
    const md = fs.readFileSync(f, "utf8").replace(
      /^# Narrated walkthrough videos$/m,
      `# Narrated walkthrough videos\n\n> Installed from \`${PLUGIN}\`. Scripts live in \`${path.join(PLUGIN, "scripts")}\`.\n> Re-run \`node ${path.join(PLUGIN, "scripts", "install-skill.mjs")}\` after updating.`
    );
    fs.writeFileSync(f, md);
    ok(`${a.name.padEnd(12)} skill → ${target}`);
  } else {
    upsertBlock(target, guidance());
    ok(`${a.name.padEnd(12)} guidance → ${target}`);
  }
  done++;
}

if (!done) {
  warn("no supported agents found");
  console.log(c(2, "\n  Looked for: ~/.claude, ~/.codex, ~/.config/opencode, ~/.config/crush"));
  console.log(c(2, "  Install one, then re-run this. Or point your agent at:"));
  console.log(c(2, `    ${path.join(PLUGIN, "skills", "narrated-walkthrough", "SKILL.md")}`));
} else if (!LIST && !REMOVE) {
  console.log(c(2, "\n  Only Claude Code loads this as a true skill; the others receive a"));
  console.log(c(2, "  guidance block in their agent-instructions file, between markers so it"));
  console.log(c(2, "  can be updated or removed cleanly. Restart the agent to pick it up."));
}
console.log("");
