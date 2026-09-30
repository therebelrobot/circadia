# Circadia blueprint GIFs

Source for the looping GIFs in the README and `docs/`. Each one is a
[Remotion](https://www.remotion.dev) scene: 3D line art projected to SVG every frame,
drawn in a hand-sketched blueprint style, then rendered to MP4 and converted to a GIF.

This is a separate package, like `examples/mastra`. Its dependencies never touch the root
`package.json`, and it is outside the root tests and typecheck.

## Commands

```bash
cd docs/media/blueprints
npm install
npm run studio                       # live preview; style props are editable
npm run gifs                         # render every scene → out/gif/*.gif
npm run gifs -- Recall-16x9          # just one
scripts/stills.sh Recall-16x9 60 110 150 215   # 2×2 contact sheet of stills
cp out/gif/*.gif ..                  # publish into docs/media/
```

Rendering needs Chrome. In a container with Playwright browsers installed, the scripts find
`/opt/pw-browsers/chromium_headless_shell-*` automatically; otherwise set
`BROWSER_EXECUTABLE`, or let Remotion download its own.

## Scenes

| composition | GIF | explains | used in |
|---|---|---|---|
| `Banner-banner` (3:1) | `banner.gif` | header: vault, index, recall pulse | README |
| `VaultIndex-16x9` | `vault-index.gif` | content vs. index; the index is rebuildable | README, ARCHITECTURE §1 |
| `Recall-16x9` | `recall.gif` | cue → seeds → spreading activation → context | README, RETRIEVAL §3 |
| `BiTemporal-16x9` | `bi-temporal.gif` | world time vs. system time, `--as-of` | README, ARCHITECTURE §8, SCHEMA §4 |
| `Sleep-16x9` | `sleep.gif` | consolidation and the schema-fit gate | README, ARCHITECTURE §3 |
| `Ladder-16x9` | `ladder.gif` | graph modes and the `auto` ladder | README, RETRIEVAL §2 |
| `Dream-16x9` | `dream.gif` | the REM pass: candidate links, never facts | README, ARCHITECTURE §10, RFC-0001 |

## Making them loop

The house blueprint style assumes a one-way shot: draw on, one camera move, done. A GIF
repeats forever, so every scene here is built to end exactly where it starts:

- **Camera:** a slow sway (`swayCamera` in `src/lib/loop.ts`), one full sine cycle per
  loop, instead of a one-way move.
- **Orbs:** `LoopOrbs` orbit exactly once per loop, and their bob and pulse run a whole
  number of cycles, so frame 0 and the last frame match.
- **Draw-on:** explainers draw on, hold, then retract before the last frame (`span()` and
  the `out` range in each scene's `T` object). The banner is always fully drawn, so the
  README header is never blank.
- Timing lives in each scene's `T` object, in seconds.

## Style

| prop | values | GIFs use |
|---|---|---|
| `lineMode` | `hand`, `clean` | `hand` |
| `grid` | `both`, `flat`, `floor`, `none` | `flat` (the moving floor grid doubles GIF size) |
| `text` | `handwritten`, `technical`, `none` | `handwritten` |

Palette, sizes and fonts are in `src/style.ts`. GIFs render at half scale, 12 fps and 32
colours with no dithering, which keeps each one around 3–5 MB. Change these in
`scripts/render-gifs.sh`, or pass `PROPS='{"grid":"both",…}'` to try other styles.

## Where things live

```
src/style.ts               palette, aspects (incl. the 3:1 banner), sizes, fonts
src/lib/projection.ts      3D → 2D camera
src/lib/sketch.ts          hand-drawn stroke wobble
src/lib/loop.ts            loop helpers: useLoop, span, cyc, swayCamera
src/lib/shapes.ts          sheets, octahedra, rings, crescents, boxes, dashes, arcs
src/lib/memory.ts          the shared vault + index picture (banner and VaultIndex)
src/components/            Strokes, Grid, Label, LoopOrbs + Glow, TextAt
src/scenes/                one file per GIF
scripts/render-gifs.sh     MP4 → GIF
scripts/stills.sh          contact sheets for checking framing
```
