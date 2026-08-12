#!/usr/bin/env node
/**
 * init.mjs — scaffold a new walkthrough project in the current directory.
 * Creates the folder layout, a config stub, .env.example and a starter script.
 * Never overwrites an existing file.
 *
 *   node init.mjs [--module tour]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const ROOT = process.cwd();
const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MODULE = arg("--module", "tour");

const put = (rel, body) => {
  const p = path.join(ROOT, rel);
  if (fs.existsSync(p)) { console.log(`  · exists, kept   ${rel}`); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  console.log(`  ✓ created        ${rel}`);
};

for (const d of ["content", "assets", "music", "public/vo", "out", ".auth"]) {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
}

const cfg = fs.readFileSync(path.join(PLUGIN, "templates", "walkthrough.config.mjs"), "utf8");
put("walkthrough.config.mjs", cfg.replace(/\btour\b/g, MODULE).replace(/s01_intro/g, `s01_intro`));

put(".env.example", fs.readFileSync(path.join(PLUGIN, "templates", "env.example"), "utf8"));

put(`content/${MODULE}.script.json`, JSON.stringify({
  meta: { fps: 30, module: MODULE, lang: "en",
    note: "Scene ids must match walkthrough.config.mjs. Sentence counts are load-bearing: step cueIdx values index sentences, so keep the count fixed when rewording. Every number spoken must be visible on screen at that moment." },
  scenes: [
    { id: "s01_intro", narration: "This is the first scene. Replace this narration with your own. Each sentence becomes a cue the recorder can fire an action on.", fallbackSeconds: 12 },
  ],
}, null, 2) + "\n");

put(".gitignore", [
  "# secrets and sessions",
  ".env",
  ".auth/",
  "",
  "# generated",
  "node_modules/",
  "out/",
  "public/vo/",
  "assets/*.png",
  "",
].join("\n"));

put("README.md", `# ${path.basename(ROOT)} — walkthrough videos

Built with the \`narrated-walkthrough\` skill. See that skill's SKILL.md for the
full workflow and the non-obvious rules.

    cp .env.example .env          # then fill it in — never commit .env
    node scripts/doctor.mjs       # can this machine capture smoothly?
    node scripts/record.mjs --login

    node scripts/generate-vo.mjs --script content/${MODULE}.script.json --out vo/${MODULE}
    node scripts/normalize-vo.mjs --script content/${MODULE}.script.json --out vo/${MODULE}
    node scripts/refresh-durations.mjs --out vo/${MODULE}
    MODULE=${MODULE} node scripts/check-cues.mjs
    MODULE=${MODULE} node scripts/verify-selectors.mjs
    MODULE=${MODULE} node scripts/record.mjs
`);

console.log(`
  Next:
    1. cp .env.example .env  and fill in the keys
    2. point walkthrough.config.mjs at your app (APP_URL) and fix the login selectors
    3. node scripts/doctor.mjs
    4. node scripts/record.mjs --login
`);
