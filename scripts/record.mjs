#!/usr/bin/env node
/**
 * record.mjs — drive a web app through a scripted walkthrough and capture it,
 * timed against a pre-generated voice-over.
 *
 *   node record.mjs --login              one-time sign-in, session → .auth/profile
 *   MODULE=tour node record.mjs          record a module
 *   MODULE=tour SCENES=s01,s02 ...       record a subset (smoke test)
 *   STEP_TIMING=1 ...                    print where each scene's time goes
 *
 * Everything project-specific comes from walkthrough.config.mjs; everything
 * secret comes from .env. This file knows about neither.
 *
 * Output: out/<module>/desktop.mp4 (or pw-video/*.webm) + timeline-mcp.json
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { loadConfig, loadPlaywright, ROOT } from "./_config.mjs";

// Config first, Playwright second: a bad config should say so, not surface as a
// module-resolution stack trace.
const { all: CFG_ALL } = await loadConfig({ needsApp: true });
const { chromium } = await loadPlaywright();

const APP = String(CFG_ALL.app || "").replace(/\/$/, "");   // validated by loadConfig({needsApp})
const W = Number(CFG_ALL.width || 1920), H = Number(CFG_ALL.height || 1080);
const MODULE = (process.env.MODULE || Object.keys(CFG_ALL.modules)[0]).toLowerCase();
const CFG = CFG_ALL.modules[MODULE];
if (!CFG) { console.error(`\n✗ unknown MODULE "${MODULE}" — one of: ${Object.keys(CFG_ALL.modules).join(", ")}\n`); process.exit(1); }

const ONLY = (process.env.SCENES || "").split(",").map((s) => s.trim()).filter(Boolean);
const SCENES = ONLY.length ? CFG.scenes.filter((s) => ONLY.includes(s.id)) : CFG.scenes;
if (!SCENES.length) { console.error(`\n✗ SCENES matched nothing in ${MODULE}\n`); process.exit(1); }

const LOGIN_ONLY = process.argv.includes("--login");
const AUTH = CFG_ALL.login || {};
const LOGIN_RE = new RegExp((AUTH.urlPattern || "/\\/(account|auth)\\/(login|register)/").replace(/^\/|\/$/g, ""));
const SHELL = AUTH.shell || "body";

const PROFILE = path.join(ROOT, ".auth", "profile");
const VIDEO_DIR = path.join(ROOT, "out", MODULE, "pw-video");
const TIMELINE = path.join(ROOT, "out", MODULE, "timeline-mcp.json");
const MANIFEST = path.join(ROOT, "public", "vo", MODULE, "manifest.json");
const DESKTOP_MP4 = path.join(ROOT, "out", MODULE, "desktop.mp4");

const CAP = CFG_ALL.capture || {};
const CAPTURE = (process.env.CAPTURE || CAP.mode || "dda").toLowerCase();
const CAP_FPS = Number(process.env.CAP_FPS || CAP.fps || 30);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLogin = (u) => LOGIN_RE.test(u);
const lbl = (st) => (st && st.label) || "";
const AC = process.env.TOUR_AC || CFG_ALL.accent || "255,107,26";

// ── on-page overlay: cursor ring, annotation callouts, sync flash ────────────
const HELPERS = `(() => {
  if (window.__tour) return; window.__tour = 1;
  const add = (el) => (document.body || document.documentElement).appendChild(el);
  const ring = document.createElement('div'); ring.id='__ring';
  Object.assign(ring.style,{position:'fixed',left:0,top:0,width:'26px',height:'26px',marginLeft:'-13px',marginTop:'-13px',borderRadius:'50%',background:'rgba(${AC},0.22)',border:'2px solid rgba(${AC},0.9)',boxShadow:'0 0 0 5px rgba(${AC},0.10)',pointerEvents:'none',zIndex:2147483640,transition:'transform .07s ease-out',transform:'translate(-100px,-100px)'});
  document.body ? add(ring) : addEventListener('DOMContentLoaded',()=>add(ring));
  addEventListener('mousemove',(e)=>{ ring.style.transform='translate('+e.clientX+'px,'+e.clientY+'px)'; },true);
  window.__noteRect=(r,label,ms=3800,pos,force)=>{const wrap=document.createElement('div');add(wrap);
    const huge=r.height>innerHeight*0.7||r.width>innerWidth*0.88;
    if(!huge||force){const box=document.createElement('div');Object.assign(box.style,{position:'fixed',left:(r.x-6)+'px',top:(r.y-6)+'px',width:(r.width+12)+'px',height:(r.height+12)+'px',border:'3px solid rgb(${AC})',borderRadius:'12px',boxShadow:'0 0 0 4px rgba(${AC},.16),0 0 22px rgba(${AC},.5)',pointerEvents:'none',zIndex:2147483641});wrap.appendChild(box);}
    if(label){const lab=document.createElement('div');lab.textContent=label;Object.assign(lab.style,{position:'fixed',pointerEvents:'none',zIndex:2147483642,maxWidth:'620px',font:'600 24px/1.35 system-ui,Segoe UI,sans-serif',color:'#fff',background:'rgba(${AC},.97)',padding:'11px 18px',borderRadius:'10px',boxShadow:'0 10px 30px rgba(0,0,0,.32)',visibility:'hidden'});wrap.appendChild(lab);
      const lw=lab.offsetWidth||300,lh=lab.offsetHeight||48,gap=14;let left,top;
      if(pos==='below'){top=Math.min(r.y+r.height+gap,innerHeight-lh-16);left=Math.max(16,Math.min(r.x,innerWidth-lw-16));}
      else if(pos==='inside'){left=Math.max(16,Math.min(r.x+24,innerWidth-lw-16));top=Math.max(90,r.y+r.height-lh-24);}
      else if(huge){left=Math.max(16,Math.min(r.x+24,innerWidth-lw-16));top=Math.max(90,r.y+18);}
      else{top=r.y-6-lh-gap;if(top<16)top=r.y+r.height+6+gap;left=Math.max(16,Math.min(r.x-6,innerWidth-lw-16));}
      lab.style.left=left+'px';lab.style.top=top+'px';lab.style.visibility='visible';}
    wrap.style.transition='opacity .3s';wrap.style.opacity='0';requestAnimationFrame(()=>wrap.style.opacity='1');
    setTimeout(()=>{wrap.style.opacity='0';setTimeout(()=>wrap.remove(),320);},ms);};
  window.__toast=(label,ms=3000)=>{const t=document.createElement('div');t.textContent=label;Object.assign(t.style,{position:'fixed',left:'50%',top:'88px',transform:'translateX(-50%)',pointerEvents:'none',zIndex:2147483643,font:'600 24px/1.35 system-ui,sans-serif',color:'#fff',background:'rgba(${AC},.97)',padding:'12px 22px',borderRadius:'999px',opacity:'0',transition:'opacity .3s'});add(t);requestAnimationFrame(()=>t.style.opacity='1');setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),320);},ms);};
  // full-frame magenta flash at t0 — the stitcher finds this to sync audio
  window.__flash=()=>{const f=document.createElement('div');Object.assign(f.style,{position:'fixed',inset:'0',background:'#ff00ff',zIndex:2147483647,pointerEvents:'none'});add(f);setTimeout(()=>f.remove(),250);};
  // heartbeat: forces a compositor frame each rAF so CDP capture stays smooth
  const beat=document.createElement('div');
  Object.assign(beat.style,{position:'fixed',left:'0',top:'0',width:'2px',height:'2px',opacity:'0.012',pointerEvents:'none',zIndex:2147483646,background:'rgb(${AC})'});
  const mountBeat=()=>{ add(beat); let n=0; (function loop(){ n=(n+1)%360; beat.style.transform='translateZ(0) rotate('+n+'deg)'; requestAnimationFrame(loop); })(); };
  document.body?mountBeat():addEventListener('DOMContentLoaded',mountBeat);
})();`;

// ── step engine ──────────────────────────────────────────────────────────────
let cx = W / 2, cy = H / 2;
async function glide(page, x, y, steps = 24) { const fx = cx, fy = cy; for (let i = 1; i <= steps; i++) { const t = i / steps, e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; await page.mouse.move(fx + (x - fx) * e, fy + (y - fy) * e); await sleep(13); } cx = x; cy = y; }
async function liveWait(page, ms) {
  if (ms <= 0) return; const t0 = Date.now(); const bx = cx, by = cy;
  while (Date.now() - t0 < ms - 40) { const t = (Date.now() - t0) / 1000; await page.mouse.move(bx + Math.sin(t * 1.3) * 8, by + Math.cos(t * 1.0) * 6); await sleep(40); }
  await page.mouse.move(bx, by); cx = bx; cy = by;
}
async function ensureVisible(loc) { const scrolled = await loc.evaluate((el) => { const r = el.getBoundingClientRect(); if (r.height > innerHeight - 120) { el.scrollIntoView({ behavior: "smooth", block: "start" }); return true; } if (r.top < 90 || r.bottom > innerHeight - 90) { el.scrollIntoView({ behavior: "smooth", block: "center" }); return true; } return false; }).catch(() => false); await sleep(scrolled ? 750 : 120); }
async function locate(page, st) { for (const s of [st.sel, st.altSel].filter(Boolean)) { let loc = page.locator(s); loc = st.nth != null ? loc.nth(st.nth) : st.last ? loc.last() : loc.first(); try { await loc.waitFor({ state: "visible", timeout: 4000 }); if (!st.noScroll) await ensureVisible(loc); const b = await loc.boundingBox(); if (b) return { loc, b }; } catch { } } return { loc: null, b: null }; }
async function unionRect(page, union) {
  if (Array.isArray(union)) { await ensureVisible(page.locator(union[0]).first()); let l = 1e9, t = 1e9, r = -1e9, b = -1e9, any = false; for (const s of union) { const box = await page.locator(s).first().boundingBox().catch(() => null); if (!box) continue; any = true; l = Math.min(l, box.x); t = Math.min(t, box.y); r = Math.max(r, box.x + box.width); b = Math.max(b, box.y + box.height); } return any ? { x: l, y: t, width: r - l, height: b - t } : null; }
  await ensureVisible(page.locator(union).first());
  return page.evaluate((s) => { const els = [...document.querySelectorAll(s)]; let l = 1e9, t = 1e9, r = -1e9, b = -1e9; for (const e of els) { const q = e.getBoundingClientRect(); if (q.width < 1 || q.height < 1) continue; l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); } return l > r ? null : { x: l, y: t, width: r - l, height: b - t }; }, union).catch(() => null);
}
async function annotateRect(page, rect, st, dur) { const p = st.pad || {}; const rr = { x: rect.x - (p.l || 0), y: rect.y - (p.t || 0), width: rect.width + (p.l || 0) + (p.r || 0), height: rect.height + (p.t || 0) + (p.b || 0) }; await page.evaluate(([r, label, d, pos, force]) => window.__noteRect && window.__noteRect(r, label, d, pos, force), [rr, lbl(st), dur, st.labelPos || null, !!st.forceBorder]); }
const canvasBox = (page, sel) => page.locator(sel || "canvas").first().boundingBox().catch(() => null);

async function runStep(page, st, dur) {
  switch (st.do) {
    case "note": {
      let rect = st.union ? await unionRect(page, st.union) : null;
      if (!rect) { const { b } = await locate(page, st); if (b) rect = b; }
      if (!rect && st.optional) break;
      if (rect) { const px = rect.x + Math.min(rect.width * 0.16, 70); await glide(page, px, rect.y + Math.min(rect.height / 2, 30), 16); await annotateRect(page, rect, st, dur + (st.holdMs || 0)); if (st.holdMs) await liveWait(page, st.holdMs); const belowY = rect.y + rect.height + 34; const parkY = belowY < H - 30 ? belowY : Math.max(30, rect.y - 34); await glide(page, px, parkY, 14); }
      break;
    }
    case "click": {
      const { loc, b } = await locate(page, st); if (b) await glide(page, b.x + b.width / 2, b.y + b.height / 2); await sleep(120);
      await loc?.click({ force: true }).catch(() => {}); await sleep(st.wait || 700); break;
    }
    case "clickNav": {
      const { loc, b } = await locate(page, st); if (b) await glide(page, b.x + b.width / 2, b.y + b.height / 2); await sleep(150);
      await loc?.click({ force: true }).catch(() => {});
      if (st.urlRe) await page.waitForURL(new RegExp(st.urlRe), { timeout: 20000 }).catch(() => {});
      await sleep(st.wait || 1600); break;
    }
    case "type": {
      const { loc, b } = await locate(page, st); if (b) { await glide(page, b.x + b.width / 2, b.y + b.height / 2, 12); if (st.label) await annotateRect(page, b, st, Math.min(dur, 2600)); }
      await loc?.click({ force: true }).catch(() => {}); await loc?.fill("").catch(() => {}); await sleep(150);
      // fill:true sets the value at once. Use it for any string containing a
      // character the app treats as a command trigger ("/" slash menus, "@"
      // mentions) — per-character typing fires those and eats the input.
      if (st.fill) { await loc?.fill(String(st.value ?? "")).catch(() => {}); await sleep(500); }
      else { await loc?.pressSequentially(String(st.value ?? ""), { delay: Number(process.env.TYPE_DELAY || 130) }).catch(() => {}); await sleep(950); }
      if (st.clearAfter) { await loc?.fill("").catch(() => {}); await sleep(250); } break;
    }
    case "select": {
      const { loc, b } = await locate(page, st); if (b) { await glide(page, b.x + b.width / 2, b.y + b.height / 2, 12); if (st.label) await annotateRect(page, b, st, Math.min(dur, 2600)); }
      await loc?.click({ force: true }).catch(() => {}); await sleep(350);
      if (st.optLabel != null) await loc?.selectOption({ label: st.optLabel }).catch(() => {});
      else await loc?.selectOption({ index: st.optIndex ?? 1 }).catch(() => {});
      await sleep(800); break;
    }
    case "menu": {
      const { loc, b } = await locate(page, st); if (b) await glide(page, b.x + b.width / 2, b.y + b.height / 2); await sleep(150);
      await loc?.click({ force: true }).catch(() => {}); await sleep(550);
      const mb = await page.locator(st.menuSel || ".dropdown-menu.show").first().boundingBox().catch(() => null);
      if (mb) await page.evaluate(([r, label, d]) => window.__noteRect && window.__noteRect(r, label, d), [mb, lbl(st), dur]);
      await sleep(Math.min(dur, 4000)); await page.keyboard.press("Escape").catch(() => {}); await sleep(350); break;
    }
    case "orbit": {
      // Drag inside a canvas so a 3D view turns. Driven by the CLOCK, not by a
      // step count: a mouse.move is a CDP round-trip nearer 40 ms than 16, so a
      // fixed count overruns badly and pushes the rest of the scene out of sync
      // with its narration.
      const c = await canvasBox(page, st.sel); if (!c) break;
      const sx = c.x + c.width * (st.fx ?? 0.5), sy = c.y + c.height * (st.fy ?? 0.5);
      await glide(page, sx, sy, 16); await sleep(150);
      await page.mouse.down();
      const ms = st.ms ?? 2600, dx = st.dx ?? 300, dy = st.dy ?? -50, tStart = Date.now();
      for (;;) {
        const t = Math.min(1, (Date.now() - tStart) / ms);
        const e = 0.5 - 0.5 * Math.cos(Math.PI * t);
        await page.mouse.move(sx + dx * e, sy + dy * e);
        if (t >= 1) break;
        await sleep(2);
      }
      await page.mouse.up();
      cx = sx + dx; cy = sy + dy;
      await sleep(st.wait || 400); break;
    }
    case "canvasClick": {
      // Pick a point inside a canvas by FRACTION of its box, with fallbacks.
      // A fraction mapped in one window size lands somewhere else at another,
      // because the content refits — so a step may list candidates and the
      // first that makes `after` appear wins.
      const c = await canvasBox(page, st.sel); if (!c) break;
      const pts = st.tries?.length ? st.tries : [[st.fx ?? 0.5, st.fy ?? 0.5]];
      let hit = false;
      for (const [fx, fy] of pts) {
        const px = c.x + c.width * fx, py = c.y + c.height * fy;
        await glide(page, px, py, hit ? 10 : 18); await sleep(200);
        await page.mouse.click(px, py); await sleep(st.wait || 1300);
        if (!st.after) { hit = true; break; }
        if (await page.locator(st.after).first().isVisible().catch(() => false)) { hit = true; break; }
      }
      if (!hit) console.log(`    ⚠ canvasClick found nothing for ${st.after || "(no probe)"}`);
      if (st.label && st.after) { const r = await page.locator(st.after).first().boundingBox().catch(() => null); if (r) await annotateRect(page, r, st, dur); }
      break;
    }
    case "wait": { await liveWait(page, st.ms ?? 2000); break; }
    case "waitDone": {
      const t0 = Date.now(); const max = st.timeout || 300000;
      while (Date.now() - t0 < max) {
        let done = false;
        if (st.minCount) done = (await page.locator(st.sel).count().catch(() => 0)) >= st.minCount;
        else if (st.text) done = (await page.locator(st.sel || "body").first().innerText().catch(() => "")).includes(st.text);
        else if (st.sel) done = await page.locator(st.sel).first().isVisible().catch(() => false);
        else if (st.gone) done = !(await page.locator(st.gone).first().isVisible().catch(() => false));
        if (done) break;
        await liveWait(page, 1200);
      }
      if (st.settle) await liveWait(page, st.settle); else await sleep(800);
      break;
    }
    case "closeModal": {
      for (const s of ['button:text-is("Cancel")', 'button:text-is("Close")', 'button[aria-label="Close"]', ".modal-header .btn-close", 'button:has-text("✕")']) {
        const c = page.locator(s).first();
        if (await c.isVisible().catch(() => false)) { const b = await c.boundingBox().catch(() => null); if (b) await glide(page, b.x + b.width / 2, b.y + b.height / 2, 12); await c.click({ force: true }).catch(() => {}); break; }
      }
      await sleep(500); await page.keyboard.press("Escape").catch(() => {}); await sleep(400); break;
    }
    default: console.log(`    ⚠ unknown step "${st.do}"`);
  }
}

async function autoLogin(page) {
  await page.goto(APP + (CFG.route || "/"), { waitUntil: "domcontentloaded" }).catch(() => {});
  await Promise.race([
    page.locator(SHELL).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
    AUTH.pass ? page.locator(AUTH.pass).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {}) : Promise.resolve(),
  ]); await sleep(900);
  if (!isLogin(page.url())) return true;
  const E = AUTH.userEnv ? process.env[AUTH.userEnv] : null;
  const P = AUTH.passEnv ? process.env[AUTH.passEnv] : null;
  if (!E || !P || !AUTH.user || !AUTH.pass) return false;
  await page.locator(AUTH.user).first().fill(E).catch(() => {});
  await page.locator(AUTH.pass).first().fill(P).catch(() => {});
  if (AUTH.remember) await page.locator(AUTH.remember).first().check().catch(() => {});
  await page.locator(AUTH.submit || 'button[type="submit"]').first().click({ force: true }).catch(() => {});
  await page.waitForURL((u) => !isLogin(u.toString()), { timeout: 30000 }).catch(() => {}); await sleep(2500);
  return !isLogin(page.url());
}

function markCleanExit() {
  for (const pref of [path.join(PROFILE, "Default", "Preferences"), path.join(PROFILE, "Preferences")]) {
    try { if (!fs.existsSync(pref)) continue; const d = JSON.parse(fs.readFileSync(pref, "utf8")); d.profile = d.profile || {}; d.profile.exit_type = "Normal"; d.profile.exited_cleanly = true; fs.writeFileSync(pref, JSON.stringify(d)); } catch { }
  }
}
function resetZoom() {
  try {
    const pref = path.join(PROFILE, "Default", "Preferences");
    if (!fs.existsSync(pref)) return;
    const j = JSON.parse(fs.readFileSync(pref, "utf8"));
    if (j.partition) { j.partition.per_host_zoom_levels = {}; j.partition.default_zoom_level = {}; }
    if (j.profile) j.profile.default_zoom_level = 0;
    fs.writeFileSync(pref, JSON.stringify(j));
  } catch { /* non-fatal */ }
}

// GPU flags are NOT optional when the page draws with WebGL/canvas: headless
// Chromium otherwise falls back to SwiftShader and renders in software (~5 fps).
const LAUNCH_ARGS = [
  "--hide-scrollbars", "--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
  "--no-first-run", "--no-default-browser-check",
  "--force-device-scale-factor=1", "--high-dpi-support=1",
  "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy",
  "--use-angle=d3d11", "--enable-features=Vulkan,CanvasOopRasterization",
  "--disable-gpu-vsync", "--disable-frame-rate-limit",
  ...(CAP.args || []),
  ...(process.env.EXTRA_ARGS ? process.env.EXTRA_ARGS.split(" ").filter(Boolean) : []),
];

/**
 * Force the capture's timeline to match real time.
 *
 * ddagrab stamps frames at the NOMINAL rate whether or not it produced them
 * that fast. Under load it can fall behind, and the file then covers less wall
 * time than its duration claims — so the picture runs progressively later than
 * narration placed at recorded offsets. `-itsscale` fixes it as a stream copy:
 * no re-encode, no quality loss.
 */
function retimeToWallClock(file, wallSeconds) {
  const dur = parseFloat((spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file], { encoding: "utf8" }).stdout || "").trim());
  if (!Number.isFinite(dur) || dur <= 0 || !(wallSeconds > 0)) { console.log("  ⚠ could not measure capture drift"); return file; }
  const drift = ((dur - wallSeconds) / wallSeconds) * 100, scale = wallSeconds / dur;
  console.log(`  · capture ${dur.toFixed(1)}s vs ${wallSeconds.toFixed(1)}s wall → drift ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}% (real ${(CAP_FPS * scale).toFixed(1)}fps)`);
  if (Math.abs(drift) < 0.25) { console.log("  · within tolerance, no retime"); return file; }
  const out = file.replace(/\.mp4$/, "-timed.mp4");
  fs.rmSync(out, { force: true });
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-itsscale", scale.toFixed(6), "-i", file, "-c", "copy", "-movflags", "+faststart", out]);
  if (r.status !== 0 || !fs.existsSync(out)) { console.log("  ⚠ retime failed — using the raw capture"); return file; }
  console.log(`  ✎ retimed ×${scale.toFixed(4)} to match wall clock`);
  return out;
}

async function main() {
  if (LOGIN_ONLY) {
    fs.mkdirSync(PROFILE, { recursive: true }); markCleanExit();
    const c = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1100, height: 760 }, args: [...LAUNCH_ARGS, "--window-size=1120,840", "--window-position=40,20"] });
    const p = c.pages()[0] || (await c.newPage());
    let ok = await autoLogin(p);
    if (!ok) {
      console.log("  … waiting for manual login (up to 10 min) — tick 'Remember me'");
      const t0 = Date.now();
      while (Date.now() - t0 < 600000) {
        await sleep(2000);
        if (!isLogin(p.url()) && await p.locator(SHELL).first().isVisible().catch(() => false)) { ok = true; break; }
      }
      if (ok) await sleep(3000);
    }
    console.log(ok ? "  ✓ logged in — session stored in .auth/profile" : "  ✗ login failed");
    await c.close(); return;
  }
  if (!fs.existsSync(PROFILE)) throw new Error("No profile. Run --login first.");

  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : { scenes: {} };
  const fps = manifest.fps || 30;
  const holdMs = (s) => (manifest.scenes?.[s.id]?.durationInFrames ?? Math.round(6 * fps)) / fps * 1000;

  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  resetZoom(); markCleanExit();

  const DDA = CAPTURE === "dda";
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: DDA ? false : process.env.TOUR_HEADLESS === "1",
    viewport: DDA ? null : { width: W, height: H },
    ...(DDA ? {} : { deviceScaleFactor: 1 }),
    ...(DDA ? {} : { recordVideo: { dir: VIDEO_DIR, size: { width: W, height: H } } }),
    args: DDA ? [...LAUNCH_ARGS, "--kiosk", "--window-position=0,0", `--window-size=${W},${H}`] : LAUNCH_ARGS,
    ignoreDefaultArgs: DDA ? ["--enable-automation"] : undefined,   // the infobar would be filmed
  });
  await context.addInitScript(HELPERS);
  context.setDefaultTimeout(6000); context.setDefaultNavigationTimeout(20000);
  const page = context.pages()[0] || (await context.newPage());
  if (!(await autoLogin(page))) { await context.close(); throw new Error("login failed — run --login"); }

  {
    const r = await page.evaluate(() => {
      try { const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
        const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "(no debug info)"; } catch { return "(unavailable)"; }
    }).catch(() => "(error)");
    console.log(`  · GPU: ${String(r).replace(/^ANGLE \(|\)$/g, "").slice(0, 74)}`);
    if (/SwiftShader|software/i.test(String(r))) console.log("  ⚠ SOFTWARE RENDERING — motion will be jerky. Record headed, and set the OS per-app GPU preference to high performance.");
  }

  const READY = CFG.ready || "body";
  let onPage = false;
  for (let i = 0; i < 6 && !onPage; i++) {
    await page.goto(APP + (CFG.route || "/"), { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2400);
    if (isLogin(page.url())) { await autoLogin(page); continue; }
    onPage = await page.locator(READY).first().waitFor({ state: "visible", timeout: 12000 }).then(() => true).catch(() => false);
    if (!onPage) await sleep(900);
  }
  if (!onPage) console.log("  ⚠ route not confirmed —", page.url());
  await sleep(CFG.settle ?? 1500); await page.mouse.move(cx, cy);

  // Pre-warm heavy routes BEFORE the clock starts, so their first appearance in
  // the take is instant rather than narrated over a loading screen.
  if (CFG.prewarm?.length) {
    for (const u of CFG.prewarm) {
      const t = Date.now();
      await page.goto(APP + u, { waitUntil: "domcontentloaded" }).catch(() => {});
      if (CFG.prewarmReady) await page.locator(CFG.prewarmReady).first().waitFor({ state: "visible", timeout: 180000 }).catch(() => {});
      await sleep(2500);
      console.log(`  · pre-warmed ${u} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
    await page.goto(APP + (CFG.route || "/"), { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.locator(READY).first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await sleep(CFG.settle ?? 1500); await page.mouse.move(cx, cy);
  }

  let ffcap = null, capStartWall = 0;
  if (DDA) {
    fs.mkdirSync(path.dirname(DESKTOP_MP4), { recursive: true });
    fs.rmSync(DESKTOP_MP4, { force: true });
    capStartWall = Date.now();
    // preset p1 + ull: the encoder shares the GPU with the page, and when it
    // falls behind the file silently stretches. draw_mouse=0 because the page
    // paints its own cursor ring.
    ffcap = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
      "-filter_complex", `ddagrab=output_idx=0:framerate=${CAP_FPS}:draw_mouse=0,hwdownload,format=bgra`,
      "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-rc", "vbr", "-cq", "20",
      "-pix_fmt", "yuv420p", "-g", String(CAP_FPS * 2), DESKTOP_MP4], { stdio: ["pipe", "inherit", "inherit"] });
    ffcap.on("error", (e) => console.log(`  ⚠ ddagrab failed to start: ${e.message}`));
    await sleep(1800);
    console.log(`  · capturing desktop @ ${CAP_FPS}fps`);
  }

  const t0 = Date.now();
  await page.evaluate(() => window.__flash && window.__flash()); await sleep(360);
  const offsets = [];
  console.log(`\nRecording ${MODULE} …\n`);
  await glide(page, W * 0.5, H * 0.42, 12);

  const LEAD_MS = Number(process.env.LEAD_MS || 450);
  for (const s of SCENES) {
    if (s.goto) {
      const u = /^(file:|https?:)/.test(s.goto) ? s.goto : APP + s.goto;
      await page.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(s.gotoWait || 1800);
      if (s.ready) await page.locator(s.ready).first().waitFor({ state: "visible", timeout: 25000 }).catch(() => {});
      if (s.parkMouse) { cx = 24; cy = H - 24; await page.mouse.move(cx, cy).catch(() => {}); }
    }
    const tScene = Date.now();
    offsets.push({ id: s.id, offset: Math.round(tScene - t0) / 1000, url: page.url() });
    console.log(`  ${s.id.padEnd(16)} @ ${((tScene - t0) / 1000).toFixed(2)}s`);
    const cues = manifest.scenes?.[s.id]?.cues || [];
    const total = holdMs(s);
    const startMs = (i) => { const ci = s.steps[i]?.cueIdx; const c = ci != null ? cues[ci] : null; return c ? c.start * 1000 : (i * 2600); };
    for (let i = 0; i < s.steps.length; i++) {
      const at = Math.max(0, startMs(i) - LEAD_MS); const wait = at - (Date.now() - tScene); if (wait > 0) await liveWait(page, wait);
      const nextAt = i + 1 < s.steps.length ? startMs(i + 1) : total;
      const dur = Math.max(2200, nextAt - (Date.now() - tScene) - 150);
      const tStep = Date.now();
      await runStep(page, s.steps[i], dur);
      if (process.env.STEP_TIMING === "1") {
        const took = Date.now() - tStep, cueAt = s.steps[i].cueIdx != null ? (cues[s.steps[i].cueIdx]?.start ?? "?") : "-";
        console.log(`      ${String(i).padStart(2)} ${String(s.steps[i].do).padEnd(11)} cue=${String(cueAt).padEnd(6)} took ${(took / 1000).toFixed(1)}s  (scene t=${((Date.now() - tScene) / 1000).toFixed(1)}s)`);
      }
    }
    const rem = total - (Date.now() - tScene); if (rem > 0) await liveWait(page, rem);
  }

  await sleep(600);
  let videoPath;
  if (DDA) {
    const capStopWall = Date.now();
    // 'q' is a clean shutdown; killing ffmpeg leaves the mp4 without a moov atom
    await new Promise((res) => {
      if (!ffcap || ffcap.exitCode !== null) return res();
      ffcap.on("close", res);
      try { ffcap.stdin.write("q"); ffcap.stdin.end(); } catch { res(); }
      setTimeout(() => { try { ffcap.kill("SIGKILL"); } catch {} res(); }, 15000);
    });
    await context.close();
    if (!fs.existsSync(DESKTOP_MP4)) throw new Error("desktop capture produced no file — is ddagrab available?");
    videoPath = retimeToWallClock(DESKTOP_MP4, (capStopWall - capStartWall) / 1000);
  } else {
    videoPath = await page.video().path();
    await context.close();
  }
  fs.writeFileSync(TIMELINE, JSON.stringify({ fps, flashDur: 0.30, voDir: `public/vo/${MODULE}`, video: path.relative(ROOT, videoPath).replace(/\\/g, "/"), offsets }, null, 2) + "\n");
  console.log(`\n✓ Recorded ${SCENES.length} scenes → ${path.relative(ROOT, videoPath)} (${(fs.statSync(videoPath).size / 1e6).toFixed(1)} MB)\n`);
}
main().catch((e) => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
