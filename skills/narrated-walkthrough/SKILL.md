---
name: narrated-walkthrough
description: Produce a narrated product-walkthrough or demo video of a web app — scripted browser automation captured to video, timed against generated text-to-speech, stitched with music and an end card. Use when asked to make a tutorial video, product demo, screencast, launch video, feature walkthrough or build-in-public video of a web application, or to re-record/extend an existing one.
---

# Narrated walkthrough videos

Turn a web app into a narrated video: write a script, generate the voice-over,
drive the app through scripted scenes while capturing the screen, then stitch the
footage against the narration with music and an end card.

The pipeline's whole trick is that **the voice-over is generated first**. Each
scene's narration is transcribed to per-sentence timestamps ("cues"), and the
recorder holds each scene for exactly its narration length and fires each action
on the sentence that describes it. Nothing is edited by hand afterwards.

## Setup

```bash
node scripts/init.mjs                  # scaffold config, .env, folders
cp templates/walkthrough.config.mjs .  # if init didn't
node scripts/doctor.mjs                # verify this machine can capture smoothly
```

Then fill in `.env` (never commit it) and `walkthrough.config.mjs` (no secrets).

## The loop

```bash
# 1. voice-over — hash-based, only changed scenes regenerate
node scripts/generate-vo.mjs --script content/tour.script.json --out vo/tour
node scripts/normalize-vo.mjs --script content/tour.script.json --out vo/tour
node scripts/refresh-durations.mjs --out vo/tour

# 2. SAFETY CHECKS — both, every time, before recording
MODULE=tour node scripts/check-cues.mjs        # cue indices in range
MODULE=tour node scripts/verify-selectors.mjs  # selectors match the RIGHT thing

# 3. record  (one-time: node scripts/record.mjs --login)
MODULE=tour node scripts/record.mjs

# 4. stitch
GAP_SPEED=3 GAP_MAX_KEEP=7 VO_LUFS=-14 \
END_IMAGE=assets/endcard.png MUSIC_FILE=music/bed.wav \
TOUR_TL=out/tour/timeline-mcp.json OUT_FILE=out/tutorials/tour/tour.mp4 \
HWENC=nvenc node scripts/stitch.mjs

# 5. prove it
MODULE=tour node scripts/verify-sync.mjs       # A/V sync + exact chapter times
```

## Authoring a module

A module is one video: a `route`, a `ready` selector, and an ordered list of
scenes. Each scene's `id` must match a scene id in the VO script.

Step types: `note` (glide + labelled callout), `click`, `clickNav`, `type`,
`select`, `menu`, `orbit` (drag a 3D canvas), `canvasClick` (pick a point in a
canvas), `wait`, `waitDone` (block on an async result), `closeModal`.

`cueIdx` on a step says which narration sentence it fires on.

## Rules that are not obvious, and cost a re-record each

**Put load waits at the END of the previous scene, never the start of the next.**
The stitcher anchors a scene's narration to the moment that scene begins. A
`waitDone` as the first step means the narration plays over a page that hasn't
drawn. Move it to the tail of the preceding scene, where the delay lands in
silence that gap-speed compresses away. Symptom: one scene's visuals run seconds
behind its own voice-over; `STEP_TIMING=1` shows the scene overrunning its
narration length. Use `prewarm` for anything heavy the take opens on.

**`cueIdx` must be less than the scene's CUE count, which is not always its
sentence count.** The aligner drops a trailing sentence when it runs out of
transcribed words, so eight sentences can yield seven cues. An out-of-range
cueIdx doesn't error — it silently falls back to a flat `index × 2600 ms` guess
and the action fires at the wrong moment. `check-cues.mjs` exists for this.

**Never trust a selector you haven't seen match.** `:has-text()` is a
case-insensitive substring match returning the first DOM hit; it will quietly
box the wrong element. Prefer `:text-is()` for buttons, and anchor on a
structural child (`.card:has(.card-title:has-text("X"))`) rather than the text
alone. `verify-selectors.mjs` prints the matched text so a wrong match is
obvious. Also: `button:has-text(X)` can match a hidden duplicate that sorts
first — append `:visible`.

**A deployed app is usually ahead of its source checkout.** Scout selectors
against the running app, not the repo.

**Fractional canvas coordinates don't survive a size change.** A pick point
mapped in a 1280-wide window lands elsewhere at 1920 because the content refits.
Give `canvasClick` a `tries: [[fx,fy], …]` list and an `after` probe selector,
and make the probe assert the *specific* thing you're claiming — if the
narration says "18 mm bore", probe for that text, not merely for "a face was
picked", or a fallback can put a contradicting number on screen.

**Drive canvas drags by the clock.** A `mouse.move` is a round-trip nearer 40 ms
than 16, so a fixed step count overruns badly. Interpolate on elapsed time.

## Capture: the difference between smooth and jerky

Three independent faults produce the same symptom. Diagnose with
`doctor.mjs`, and measure **unique** frames (`-vf mpdecimate -fps_mode vfr`) on a
**moving** scene — a static screen has almost no unique frames, so an average
over stillness is meaningless.

| Fault | Symptom | Fix |
|---|---|---|
| Software rendering | Everything juddery; ANGLE reports SwiftShader | GPU flags (already in `record.mjs`) **and** the OS per-app GPU preference — on Windows, `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`, `GpuPreference=2` for `chrome.exe`. A command-line flag alone will not pick the discrete GPU on a hybrid laptop. |
| CDP capture ceiling | Page renders 60 fps, video still juddery | `capture.mode: "dda"`. Playwright's recordVideo cannot carry 1080p motion — single-digit unique fps regardless of headless/headed or vsync flags. |
| Timebase stretch | Fine for minutes, then picture lags further and further behind the VO | The capture fell behind and stamped frames at the nominal rate anyway. `record.mjs` measures wall-clock against file duration and corrects with `-itsscale` (stream copy). Reduce encode cost if drift is large. |

Rough numbers from a real project, same orbiting scene: CDP ≈ 2–4 unique fps;
Desktop Duplication ≈ 20–23. If the app is static DOM, none of this matters and
`cdp` is fine.

**Desktop Duplication runs headed and takes over the screen** for the length of
the take. The display resolution must equal the capture size exactly. Anything
that pops up on top gets filmed.

## Writing the narration

- One JSON file, one entry per scene: `{ id, narration, fallbackSeconds }`.
- **Keep the sentence count stable when rewording** — `cueIdx` values index
  sentences.
- Avoid periods inside abbreviations: the splitter breaks on `.!?`, so "e.g."
  or "D.S.A." shatters the cue count. Write "M C P" to have letters spelled out.
- Every number spoken must be visible on screen at that moment. Read figures off
  the running app and record where each came from; do not carry them over from
  an earlier take without re-checking.
- For an outro, either let the last scene's later sentences play over the end
  card (the stitch's `OUTRO_HANDOFF`, on by default), or set `OUTRO_HANDOFF=0`
  and keep the footage moving under the whole call to action. Measure first: the
  handoff can leave 20+ seconds of static card.

## Chapter times

Use `verify-sync.mjs`. Do not derive them by scaling recorded offsets — gap-speed
compresses only the silent stretches, so a linear estimate drifts far enough to
shift a late chapter by a whole scene.

## Sessions

Auth lives in `.auth/profile` via `record.mjs --login`. Sessions can be short;
a long take plus verification can outlive one. Setting the credential env vars
named in `config.login` lets the recorder re-authenticate itself, including
mid-run. Copying a browser profile from elsewhere generally does **not** carry
the session.

## Files

```
walkthrough.config.mjs      app, selectors, scenes        (no secrets)
.env                        API keys, credentials         (never commit)
content/<module>.script.json narration
assets/*.html               end card + chapter cards → render-cards.mjs
public/vo/<module>/         generated audio + manifest
out/<module>/               capture + timeline
out/tutorials/<module>/     the finished mp4
```
