# screencast-studio

Make **narrated product-walkthrough videos of web apps** — automatically.

You write a script and a list of scenes. The pipeline generates the voice-over,
drives a real browser through your app while capturing the screen, and cuts the
footage against the narration with a music bed and an end card. No video editor,
no manual timing, no re-recording because you fluffed a sentence.

Built as a [Claude Code](https://claude.com/claude-code) plugin, but the scripts
are plain Node ESM and run fine on their own.

---

## The idea

**The voice-over is generated first.** It's then transcribed to per-sentence
timestamps, and the browser is driven against those timestamps — so the click
happens on the sentence that describes the click, and the callout appears on the
sentence that explains it. The edit falls out of the data instead of being
assembled by hand.

```
script.json ──► text-to-speech ──► per-sentence cue timings
                                            │
                                            ▼
              walkthrough.config.mjs ──► browser automation + screen capture
                                            │
                                            ▼
                     cut to narration, speed silent gaps, music, end card
                                            │
                                            ▼
                                     finished .mp4 + chapters
```

Change one sentence and only that scene's audio regenerates. Re-record and the
timing still lines up.

---

## Install

**Windows**

```powershell
powershell -c "irm https://raw.githubusercontent.com/Argentron-Technologies/screencast-studio/main/install.ps1 | iex"
```

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/Argentron-Technologies/screencast-studio/main/install.sh | sh
```

**Already cloned, or prefer not to pipe a script into a shell**

```bash
git clone https://github.com/Argentron-Technologies/screencast-studio.git
node screencast-studio/install.mjs
```

All three run the same code: the shell scripts only check for `node` and `git`,
clone, and hand over to `install.mjs`, which does the real work. It needs no
admin/sudo, installs nothing but this repo, touches nothing outside your home
directory, reports which capture backend and hardware encoder your machine has,
and re-running it updates in place. Set `SCS_DIR` to change the location.

## Quickstart

```bash
mkdir my-videos && cd my-videos
npm init -y && npm i -D playwright && npx playwright install chromium

node "$SCREENCAST_STUDIO/scripts/init.mjs" --module tour
cp .env.example .env            # fill in — never commit this
```

Check the machine can actually capture smoothly before spending time on a take:

```bash
node "$SCREENCAST_STUDIO/scripts/doctor.mjs"
node "$SCREENCAST_STUDIO/scripts/doctor.mjs" --url https://your.app
```

Then point `walkthrough.config.mjs` at your app, sign in once, and run the loop:

```bash
S="$SCREENCAST_STUDIO/scripts"

node $S/record.mjs --login                                   # once

node $S/generate-vo.mjs --script content/tour.script.json --out vo/tour
node $S/normalize-vo.mjs --script content/tour.script.json --out vo/tour
node $S/refresh-durations.mjs --out vo/tour

MODULE=tour node $S/check-cues.mjs                           # cue indices in range
MODULE=tour node $S/verify-selectors.mjs                     # selectors hit the right thing
MODULE=tour node $S/record.mjs                               # the take

GAP_SPEED=3 VO_LUFS=-14 END_IMAGE=assets/endcard.png MUSIC_FILE=music/bed.wav \
TOUR_TL=out/tour/timeline-mcp.json OUT_FILE=out/tutorials/tour/tour.mp4 \
node $S/stitch.mjs

MODULE=tour node $S/verify-sync.mjs                          # prove sync, get chapters
```

### As a Claude Code skill

Clone it somewhere Claude Code can see and ask for a walkthrough video — the
`narrated-walkthrough` skill carries the whole workflow, including the rules
below, so the agent won't rediscover them the hard way.

---

## Requirements

| | |
|---|---|
| Node | 18+ |
| `playwright` | installed in **your project**, not the plugin |
| `ffmpeg` / `ffprobe` | on PATH |
| `ddagrab` + `h264_nvenc` | for the high-quality capture path (Windows + NVIDIA) |
| `CLOUDTTS_API_KEY` | Google Cloud Text-to-Speech — the narration voice |
| `OPENAI_API_KEY` | word-level transcription — cue timings and sync verification |

Desktop Duplication capture is **Windows-only** and runs headed, taking over the
screen for the length of the take. Elsewhere set `capture.mode: "cdp"`, which is
fine for static DOM but cannot carry continuous motion — see below.

---

## Why "the video looks jerky" has three different causes

This is the part that took longest to learn, so it ships as documentation and as
a diagnostic (`doctor.mjs`) rather than as folklore.

| Cause | Looks like | Fix |
|---|---|---|
| **Software rendering** | Everything juddery; ANGLE reports SwiftShader | GPU flags (built in) *and* the OS per-app GPU preference. On a hybrid laptop a command-line flag alone will not select the discrete GPU. |
| **Capture ceiling** | Page renders at 60 fps, video still juddery | Playwright's `recordVideo` streams frames over CDP as JPEGs and can't carry 1080p motion — single-digit unique fps regardless of headless/headed or vsync flags. Use `capture.mode: "dda"`. |
| **Timebase stretch** | Fine for minutes, then the picture drifts further and further behind the voice | The capture fell behind but stamped frames at the nominal rate anyway. `record.mjs` measures wall-clock against file duration and corrects it with `-itsscale` (a stream copy, no re-encode). |

Measured on one real project, same moving scene: CDP ≈ **2–4** unique fps,
Desktop Duplication ≈ **20–23**.

Measure **unique** frames (`-vf mpdecimate -fps_mode vfr`), and measure on a
**moving** scene — a static screen legitimately has almost no unique frames, so
an average over stillness tells you nothing.

---

## Other rules that each cost a wasted take

- **Put page-load waits at the end of the *previous* scene**, never the start of
  the next. Narration is anchored to the moment a scene begins, so a leading
  wait plays the voice-over over a blank page.
- **`cueIdx` indexes cues, and the cue count isn't always the sentence count** —
  the aligner drops a trailing sentence when it runs out of transcribed words.
  An out-of-range index doesn't error, it silently mistimes. Hence
  `check-cues.mjs`.
- **`:has-text()` is a case-insensitive substring match returning the first
  hit** — it will quietly box the wrong element. `verify-selectors.mjs` prints
  what each selector actually matched.
- **Fractional canvas coordinates don't survive a resolution change.** Give
  `canvasClick` several candidate points and a probe that asserts the *specific*
  thing the narration claims.
- **Derive chapter times from the finished mix**, not by scaling recorded
  offsets — gap-speed compresses only the silent stretches, and a linear
  estimate drifts far enough to shift a late chapter by a whole scene.

Full detail in [`skills/narrated-walkthrough/SKILL.md`](skills/narrated-walkthrough/SKILL.md).

---

## Layout

```
skills/narrated-walkthrough/SKILL.md   the workflow and the non-obvious rules
scripts/
  init.mjs              scaffold a project
  doctor.mjs            can this machine capture smoothly?
  record.mjs            drive the app, capture the screen
  generate-vo.mjs       text-to-speech + cue alignment
  normalize-vo.mjs      loudness-normalise narration
  refresh-durations.mjs re-probe durations into the manifest
  check-cues.mjs        every cueIdx in range
  verify-selectors.mjs  every selector matches the right thing
  stitch.mjs            cut, gap-speed, end card, music bed
  verify-sync.mjs       prove A/V sync; emit exact chapter times
  render-cards.mjs      assets/*.html → 1920×1080 PNG
templates/              config + .env examples
```

In your project: `walkthrough.config.mjs` (app, selectors, scenes — safe to
commit), `.env` (keys and credentials — never commit),
`content/<module>.script.json` (narration), `assets/*.html` (end card and
full-screen chapter cards).

---

## Security

This repository contains **no credentials, URLs or project data**. Secrets live
in your project's `.env`, which `init.mjs` gitignores along with `.auth/`
(browser sessions hold live cookies and tokens). Everything project-specific
lives in `walkthrough.config.mjs`, which is designed to be safe to commit —
it holds env-var *names*, never values.
