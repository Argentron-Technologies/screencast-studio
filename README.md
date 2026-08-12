# screencast-studio

Make **narrated product-walkthrough videos of web apps** — automatically.

The voice-over is generated first and transcribed to per-sentence timings, then
a real browser is driven against those timings while the screen is captured. The
click happens on the sentence that describes it. No video editor, no manual
timing.

A [Claude Code](https://claude.com/claude-code) plugin; the scripts are plain
Node and run standalone.

## Install

```powershell
# Windows
powershell -c "irm https://raw.githubusercontent.com/Argentron-Technologies/screencast-studio/main/install.ps1 | iex"
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Argentron-Technologies/screencast-studio/main/install.sh | sh
```

Installs the tool, registers it with your coding agents, then asks where to put
your first project and runs the setup wizard there. No admin/sudo. Re-run to
update. `SCS_NO_WIZARD=1` to skip the wizard, `SCS_DIR` to change the location.

Prefer not to pipe into a shell:

```bash
git clone https://github.com/Argentron-Technologies/screencast-studio.git
node screencast-studio/install.mjs
```

## Use

```bash
mkdir my-videos && cd my-videos
node "$SCREENCAST_STUDIO/scripts/setup.mjs"     # prerequisites, keys, scaffold
```

The wizard verifies each API key against the live service before writing it —
a typo otherwise surfaces ten minutes into generating a voice-over.

Then describe your video in two files: `walkthrough.config.mjs` (scenes and
selectors) and `content/<module>.script.json` (narration). Run the loop:

```bash
S="$SCREENCAST_STUDIO/scripts"

node $S/record.mjs --login                      # once

node $S/generate-vo.mjs   --script content/tour.script.json --out vo/tour
node $S/normalize-vo.mjs  --script content/tour.script.json --out vo/tour
node $S/refresh-durations.mjs --out vo/tour

MODULE=tour node $S/check-cues.mjs              # always, before recording
MODULE=tour node $S/verify-selectors.mjs        # always, before recording
MODULE=tour node $S/record.mjs
node $S/stitch.mjs                              # env vars in SKILL.md
MODULE=tour node $S/verify-sync.mjs             # proves sync, emits chapters
```

## Requirements

Node 18+, `ffmpeg` on PATH, `playwright` installed **in your project**, plus a
Google Cloud TTS key (narration) and an OpenAI key (word-level transcription).

Full-rate screen capture uses Desktop Duplication and is **Windows-only**; it
runs headed and takes over the screen. Elsewhere, `capture.mode: "cdp"` works
for static DOM but cannot carry motion. Run `doctor.mjs` to see what your
machine supports.

## Agents

```bash
node "$SCREENCAST_STUDIO/scripts/install-skill.mjs"   # --list  --remove
```

Claude Code gets a real skill in `~/.claude/skills/`. Codex, OpenCode and Crush
get a guidance block in their instructions file — only Claude Code has a
first-class skills format. Nothing is written for an agent that isn't installed.

## Read this before your first take

[`skills/narrated-walkthrough/SKILL.md`](skills/narrated-walkthrough/SKILL.md)
has the workflow and the failure modes that cost a re-record each — where load
waits belong, why cue counts differ from sentence counts, and the three separate
causes of jerky output (they need three different fixes; `doctor.mjs` tells you
which one you have).

## Security

No credentials or URLs in this repo. Secrets go in your project's `.env`, which
the wizard gitignores along with `.auth/`. `walkthrough.config.mjs` holds env-var
names, never values, and is safe to commit.
