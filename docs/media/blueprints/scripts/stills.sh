#!/usr/bin/env bash
# Contact sheet of 4 half-scale stills for one composition.
# usage: scripts/stills.sh <CompositionId> <frame> <frame> <frame> <frame>
set -euo pipefail
id=$1; shift
BROWSER=${BROWSER_EXECUTABLE:-$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell 2>/dev/null | head -1)}
opts=(--scale=0.5 --log=error)
[ -n "$BROWSER" ] && opts+=(--browser-executable="$BROWSER")
files=()
for f in "$@"; do
  npx remotion still src/index.ts "$id" "out/$id-f$f.png" --frame="$f" "${opts[@]}" >/dev/null
  files+=(-i "out/$id-f$f.png")
done
ffmpeg -y -loglevel error "${files[@]}" -filter_complex "[0][1]hstack[x];[2][3]hstack[y];[x][y]vstack" "out/$id-sheet.png"
echo "out/$id-sheet.png"
