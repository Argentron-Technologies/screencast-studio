// Shared bootstrap: load .env, load walkthrough.config.mjs, resolve the module.
// Kept in one place so every script agrees on where things live.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = process.cwd();

export function loadEnv() {
  const p = path.join(ROOT, ".env"); if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("="); if (i < 0) continue;
    const k = l.slice(0, i).trim(); let v = l.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

export async function loadConfig({ needsApp = false } = {}) {
  loadEnv();
  const p = path.resolve(ROOT, process.env.CONFIG || "walkthrough.config.mjs");
  if (!fs.existsSync(p)) {
    console.error(`\n✗ no config at ${path.relative(ROOT, p)} — copy templates/walkthrough.config.mjs into your project root.\n`);
    process.exit(1);
  }
  const all = (await import(pathToFileURL(p).href)).default;
  const name = (process.env.MODULE || Object.keys(all.modules || {})[0] || "").toLowerCase();
  const mod = (all.modules || {})[name];
  if (!mod) { console.error(`\n✗ unknown MODULE "${name}" — one of: ${Object.keys(all.modules || {}).join(", ") || "(none defined)"}\n`); process.exit(1); }
  const app = String(all.app || "").replace(/\/$/, "");
  // Fail here with an explanation rather than letting a placeholder URL surface
  // later as ERR_NAME_NOT_RESOLVED from somewhere inside Playwright.
  if (needsApp && (!app || /example\.test/.test(app))) {
    console.error(`\n✗ config.app is not set — point it at your app.\n  Set APP_URL in .env, or edit \`app:\` in ${path.relative(ROOT, p)}.\n`);
    process.exit(1);
  }
  return { all, mod, name, app };
}

export function readManifest(moduleName) {
  const p = path.join(ROOT, "public", "vo", moduleName, "manifest.json");
  if (!fs.existsSync(p)) { console.error(`\n✗ no VO manifest at ${path.relative(ROOT, p)} — generate the voice-over first.\n`); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Resolve Playwright from the PROJECT, then the plugin.
 *
 * These scripts live in the plugin directory, so a bare `import "playwright"`
 * resolves against the plugin's own node_modules and ignores the copy the
 * project already has installed. Import it dynamically instead, trying the
 * project's tree first — and do it lazily, so a missing dependency doesn't
 * pre-empt the config checks with a module-resolution stack trace.
 */
export async function loadPlaywright() {
  // Playwright's entry point is CommonJS. Imported by bare specifier Node can
  // usually detect its named exports, but imported by absolute path it cannot,
  // and `chromium` lands on `.default` instead — which fails later as an
  // undefined-property error far from the cause. Normalise both shapes here.
  const norm = (m) => (m?.chromium ? m : m?.default?.chromium ? m.default : m);
  const tried = [];
  try { const m = norm(await import("playwright")); if (m?.chromium) return m; tried.push("plugin"); }
  catch { tried.push("plugin"); }
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(path.join(ROOT, "package.json"));
    const m = norm(await import(pathToFileURL(req.resolve("playwright")).href));
    if (m?.chromium) return m;
    tried.push("project");
  } catch { tried.push("project"); }
  console.error(`\n✗ Playwright not found (looked in: ${tried.join(", ")}).\n  Install it in your project:  npm i -D playwright && npx playwright install chromium\n`);
  process.exit(1);
}
