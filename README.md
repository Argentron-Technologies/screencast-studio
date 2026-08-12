# screencast-studio

A Claude Code plugin for making **narrated product-walkthrough videos of web
apps**. Scripted browser automation is captured to video and timed against
generated speech, then stitched with a music bed and an end card.

The pipeline generates the **voice-over first**, transcribes it to per-sentence
timestamps, and drives the browser against those timestamps — so each action
happens on the sentence that describes it, and nothing is edited by hand
afterwards.

## Install

```bash
/plugin marketplace add <owner>/screencast-studio
/plugin install screencast-studio
```

Or use it directly: the scripts are plain Node ESM and need only `playwright`
plus `ffmpeg`/`ffprobe` on PATH.

## Start a project

```bash
mkdir my-videos && cd my-videos
npm init -y && npm i -D playwright && npx playwright install chromium
node <plugin>/scripts/init.mjs --module tour

cp .env.example .env        # fill in — never commit
node <plugin>/scripts/doctor.mjs
```

`doctor.mjs` is worth running before your first take. It checks ffmpeg,
Desktop Duplication, an NVENC encoder and the API keys, then measures whether
the capture actually holds its nominal frame rate. Pass `--url` to also measure
the page's render rate across headless/GPU/headed configurations.

## Requirements

| | |
|---|---|
| Node | 18+ |
| `playwright` | in the **project**, not the plugin |
| `ffmpeg` / `ffprobe` | on PATH; `ddagrab` + `h264_nvenc` for the high-quality capture path |
| `CLOUDTTS_API_KEY` | Google Cloud Text-to-Speech, for narration |
| `OPENAI_API_KEY` | word-level transcription — cue timings and sync verification |

Desktop Duplication capture is **Windows-only** and runs headed. On other
platforms set `capture.mode: "cdp"`, which is fine for static DOM but cannot
carry continuous motion.

## What's in it

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

## Security

The plugin contains no credentials, URLs or project data. Secrets live in your
project's `.env` (gitignored by `init.mjs`); everything else lives in
`walkthrough.config.mjs`, which is safe to commit. Browser sessions are stored
in `.auth/`, also gitignored.

## Read the skill

`skills/narrated-walkthrough/SKILL.md` documents the rules that each cost a
wasted take to learn — where to put load waits, why cue counts differ from
sentence counts, why a fixed canvas coordinate breaks at a different resolution,
and the three separate faults that all present as "the video is jerky".
