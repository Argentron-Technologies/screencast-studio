#!/usr/bin/env sh
#
#  screencast-studio installer — macOS / Linux bootstrapper
#
#      curl -fsSL https://raw.githubusercontent.com/Argentron-Technologies/screencast-studio/main/install.sh | sh
#
#  This file deliberately does almost nothing: it checks for node and git,
#  clones the repo, then hands over to install.mjs, which holds all the real
#  logic and behaves identically on every platform.
#
#  No sudo, nothing installed but this repo, nothing touched outside your home
#  directory. Re-run to update.
#
#  Override the location:  SCS_DIR=~/tools/scs; curl -fsSL ... | sh
#
#  POSIX sh, not bash — so it also works where bash is absent (Alpine, minimal
#  containers).

set -eu

REPO="https://github.com/Argentron-Technologies/screencast-studio.git"
DEST="${SCS_DIR:-$HOME/.screencast-studio}"

if ! command -v node >/dev/null 2>&1; then
  echo "  [x]  Node.js 18+ required. Install it first:" >&2
  echo "         macOS: brew install node   Linux: your package manager" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "  [x]  git required." >&2
  exit 1
fi

if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --quiet origin
  git -C "$DEST" reset --hard --quiet origin/main
elif [ -e "$DEST" ]; then
  echo "  [x]  $DEST exists but is not a git clone. Move it aside, or set SCS_DIR." >&2
  exit 1
else
  git clone --quiet --depth 1 "$REPO" "$DEST"
fi

SCS_DIR="$DEST" node "$DEST/install.mjs"
