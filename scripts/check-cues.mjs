#!/usr/bin/env node
/**
 * check-cues.mjs — every step's cueIdx must be < its scene's cue count.
 *
 * Cues are the narration's sentences, recovered by the alignment pass. A cueIdx
 * past the last cue does NOT error: the recorder silently falls back to a flat
 * `stepIndex * 2600 ms` guess, so the action fires at the wrong moment and you
 * only find out by watching the finished video.
 *
 * The trap: the cue count is not always the sentence count. The aligner drops a
 * trailing sentence when it runs out of transcribed words, so a scene with
 * eight sentences can yield seven cues.
 *
 * Run after every VO regeneration and after editing scene steps.
 *   MODULE=tour node check-cues.mjs
 */
import { loadConfig, readManifest, fmt } from "./_config.mjs";

const { mod, name } = await loadConfig();
const man = readManifest(name);

let bad = 0, frames = 0;
console.log(`\n${name} — cue range check\n`);
for (const s of mod.scenes) {
  const entry = man.scenes[s.id];
  const cues = entry?.cues || [];
  frames += entry?.durationInFrames || 0;
  const max = Math.max(-1, ...s.steps.map((x) => x.cueIdx ?? -1));
  const over = max >= cues.length;
  if (over) bad++;
  console.log(`  ${over ? "✗" : "✓"} ${s.id.padEnd(16)} cues=${String(cues.length).padEnd(3)} maxCueIdx=${String(max).padEnd(3)} steps=${s.steps.length}${over ? "   <<< OUT OF RANGE" : ""}`);
  if (!entry) { bad++; console.log(`      ⚠ no VO for this scene id — does it match the script's scene id?`); }
}
const secs = frames / (man.fps || 30);
console.log(`\n  narration total ≈ ${fmt(secs)}`);
console.log(bad ? `\n✗ ${bad} problem(s)\n` : "\n✓ every cueIdx is in range\n");
process.exit(bad ? 1 : 0);
