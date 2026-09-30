import { AbsoluteFill } from "remotion";
import { FlatGrid, FloorGrid } from "../components/Grid";
import { Label } from "../components/Label";
import { Glow, GlowDefs } from "../components/LoopOrbs";
import { Strokes, type Stroke3D } from "../components/Strokes";
import { useFontsReady } from "../fonts";
import { swayCamera, useLoop } from "../lib/loop";
import { lerp3, project, type Vec3 } from "../lib/projection";
import { octa, polyline, withIds } from "../lib/shapes";
import { palette, type StyleProps } from "../style";

// docs/RETRIEVAL.md §2: the `auto` ladder. The same notes on three rungs, each with more
// structure (and cost). A query starts on the cheapest rung and climbs only when the
// result looks weak: too few seeds, no hits, or no clear winner.

const LEVELS = [-1.0, 0.0, 1.0];
const NAMES = ["wikilink: links you wrote · free", "typed: + dated facts · free", "hipporag: + LLM triples · cached"];
const N: [number, number][] = [[-0.9, -0.35], [-0.35, 0.4], [0.2, -0.45], [0.7, 0.3], [-0.05, 0.05], [0.95, -0.4], [-0.8, 0.45]];
const E0: [number, number][] = [[0, 4], [4, 1], [4, 3], [2, 5]];
const E1: [number, number][] = [...E0, [0, 6], [2, 4], [3, 5], [1, 6]];
const PH: [number, number][] = [[-0.55, 0.0], [0.45, -0.05], [0.4, 0.55], [-0.45, -0.5]]; // phrase nodes
const E2: [number, number][] = [...E1, [0, 1], [1, 3], [2, 3]];
const PHE: [number, number][] = [[0, 0], [0, 4], [1, 2], [1, 3], [2, 1], [2, 3], [3, 0], [3, 2]]; // [phrase, node]

const T = {
  grid: [0, 1.6],
  planes: [[0.3, 1.5], [0.6, 1.8], [0.9, 2.1]],
  edges: [1.2, 2.6],
  names: [[1.9, 2.7], [2.2, 3.0], [2.5, 3.3]],
  query: [3.4, 3.9],
  lblWeak: [3.9, 4.7],
  climb: [4.9, 5.9],
  lblStop: [6.1, 6.9],
  out: [8.8, 9.8],
};

const P = (x: number, y: number, z: number): Vec3 => [x * 1.25, y, z * 1.1];

export const Ladder: React.FC<StyleProps> = ({ lineMode, grid, text }) => {
  useFontsReady();
  const { width, height, minDim, at, span, cyc } = useLoop();
  const camera = swayCamera(width, height, cyc(1), { yaw: -0.35, yawAmp: 0.15, pitch: -0.5, pitchAmp: 0.02, zoom: 0.7, cx: 0.44, cy: 0.5 });
  const out = 1 - at(T.out);
  const common = { textMode: text, lineMode, minDim, frameWidth: width } as const;

  const plane = (k: number): Stroke3D[] => {
    const y = LEVELS[k];
    const outline = polyline([P(-1.4, y, -0.8), P(1.4, y, -0.8), P(1.4, y, 0.8), P(-1.4, y, 0.8), P(-1.4, y, -0.8)]);
    const nodes = N.flatMap(([x, z]) => octa(P(x, y, z), 0.05));
    return withIds([...outline, ...nodes], `pl${k}`, { opacity: k === 2 ? 0.55 : 1 });
  };
  const edges = (k: number): Stroke3D[] => {
    const y = LEVELS[k];
    const list = [E0, E1, E2][k];
    const segs = list.map(([a, b]) => ({ a: P(N[a][0], y, N[a][1]), b: P(N[b][0], y, N[b][1]) }));
    if (k === 2) {
      for (const [x, z] of PH) segs.push(...octa(P(x, y, z), 0.03));
      for (const [ph, n] of PHE) segs.push({ a: P(PH[ph][0], y, PH[ph][1]), b: P(N[n][0], y, N[n][1]) });
    }
    return withIds(segs, `ed${k}`, { weight: 0.8, opacity: k === 2 ? 0.45 : 0.8 });
  };

  // The query: seeds on the bottom rung, then the whole search climbs one rung.
  const climb = at(T.climb);
  const qy = LEVELS[0] + (LEVELS[1] - LEVELS[0]) * climb;
  const seedA = P(N[4][0], qy, N[4][1]);
  const seedB = P(N[1][0], qy, N[1][1]);
  const seedC = P(N[3][0], qy, N[3][1]);
  const qOn = at(T.query) * out;
  const winner = at([5.6, 6.2]); // on the typed rung, one hit clearly wins

  const showFloor = grid === "floor" || grid === "both";

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <GlowDefs />
        {(grid === "flat" || grid === "both") && <FlatGrid width={width} height={height} />}
        {showFloor && <FloorGrid camera={camera} minDim={minDim} reveal={at(T.grid) * out} extent={3} />}
        {[0, 1, 2].map((k) => (
          <g key={k}>
            <Strokes segments={edges(k)} camera={camera} progress={at(T.edges) * out} mode={lineMode} minDim={minDim} />
            <Strokes segments={plane(k)} camera={camera} progress={at(T.planes[k]) * out} mode={lineMode} minDim={minDim} />
          </g>
        ))}
        <Strokes segments={[{ a: lerp3(seedA, seedA, 0), b: [seedA[0], LEVELS[1], seedA[2]], id: "rise", weight: 1.3 }]}
          camera={camera} progress={climb * out * (1 - winner * 0)} mode={lineMode} minDim={minDim} color={palette.accent} />
        <Glow at={seedA} camera={camera} minDim={minDim} strength={qOn} size={1.4 + winner * 1.2} />
        <Glow at={seedB} camera={camera} minDim={minDim} strength={qOn * (1 - winner * 0.6)} size={1.2} />
        <Glow at={seedC} camera={camera} minDim={minDim} strength={qOn * (1 - winner * 0.6)} size={1.2} />
        {[0, 1, 2].map((k) => (
          <Label key={k} anchor={project(P(1.4, LEVELS[k], -0.8), camera)} text={NAMES[k]} side={1} rise={1} reach={0.6}
            progress={span(T.names[k], T.out)} seed={`l-n${k}`} {...common} />
        ))}
        <Label anchor={project(seedA, camera)} text="weak result? climb one rung" side={-1} rise={-1} reach={2.2}
          progress={span(T.lblWeak, [6.0, 6.5])} seed="l-weak" {...common} />
        <Label anchor={project(seedA, camera)} text="clear winner: stop here" side={-1} rise={1} reach={2.2}
          progress={span(T.lblStop, T.out)} seed="l-stop" {...common} />
      </svg>
    </AbsoluteFill>
  );
};
