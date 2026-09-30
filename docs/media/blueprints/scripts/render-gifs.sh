#!/usr/bin/env bash
# Render every composition to MP4 at half scale, then to a seamless looping GIF.
# usage: scripts/render-gifs.sh [CompositionId ...]   (default: all)
set -euo pipefail
cd "$(dirname "$0")/.."
BROWSER=${BROWSER_EXECUTABLE:-$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell 2>/dev/null | head -1)}
# GIFs drop the 3D floor grid: it moves with the camera every frame and roughly doubles
# the file size. The flat paper grid is static, so it costs almost nothing.
PROPS=${PROPS:-'{"lineMode":"hand","grid":"flat","text":"handwritten"}'}
opts=(--scale=0.5 --concurrency=2 --log=error --props="$PROPS")
[ -n "$BROWSER" ] && opts+=(--browser-executable="$BROWSER")
ids=("$@")
[ ${#ids[@]} -eq 0 ] && ids=(Banner-banner VaultIndex-16x9 Recall-16x9 BiTemporal-16x9 Sleep-16x9 Ladder-16x9 Dream-16x9)
mkdir -p out/gif
for id in "${ids[@]}"; do
  npx remotion render src/index.ts "$id" "out/$id.mp4" "${opts[@]}"
  name=$(echo "${id%-*}" | sed -E 's/([a-z])([A-Z])/\1-\2/g' | tr 'A-Z' 'a-z')
  # 12 fps (an even divisor of 24), 32 colours, no dither: dithering makes every frame
  # differ and GIF compresses on frame differences. -loop 0 = loop forever.
  w=800; [[ $id == *banner ]] && w=1200
  ffmpeg -y -loglevel error -i "out/$id.mp4" -filter_complex \
    "fps=12,scale=$w:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=32:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
    -loop 0 "out/gif/$name.gif"
  echo "$id -> out/gif/$name.gif ($(du -h "out/gif/$name.gif" | cut -f1))"
done
