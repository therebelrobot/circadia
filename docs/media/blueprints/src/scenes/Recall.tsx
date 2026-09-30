import { AbsoluteFill } from "remotion";
import { FlatGrid, FloorGrid } from "../components/Grid";
import { Label } from "../components/Label";
import { Glow, GlowDefs, LoopOrbs, makeLoopOrbs } from "../components/LoopOrbs";
import { Strokes, type Stroke3D } from "../components/Strokes";
import { TextAt } from "../components/TextAt";
import { useFontsReady } from "../fonts";
import { clamp01, swayCamera, useLoop } from "../lib/loop";
import { lerp3, project, type Vec3 } from "../lib/projection";
import { octa, planar, sheet, withIds } from "../lib/shapes";
import { palette, type StyleProps } from "../style";

// docs/RETRIEVAL.md §3: cue → seeds → personalized PageRank → ranked passages → context.

const P: Vec3[] = [
  [-1.25, 0.25, 0.2], [-0.7, 0.65, -0.55], [-0.55, -0.25, 0.75], [-0.35, 0.15, 0.05],
  [0.1, 0.7, -0.2], [0.25, -0.55, 0.55], [0.45, 0.1, -0.75], [0.6, 0.35, 0.35],
  [1.05, -0.25, -0.15], [1.2, 0.65, -0.35], [1.45, 0.05, 0.6], [-1.1, -0.6, -0.5],
  [-0.1, -0.75, -0.35], [0.9, -0.8, 0.25],
];
const E: [number, number][] = [
  [0, 1], [0, 3], [0, 2], [0, 11], [1, 3], [1, 4], [2, 3], [2, 5], [3, 7], [3, 4], [3, 12],
  [4, 6], [4, 7], [5, 7], [5, 12], [6, 8], [6, 9], [7, 8], [7, 10], [8, 9], [8, 13], [10, 13],
  [11, 12], [12, 13], [9, 10],
];
const SEEDS = [3, 7];
const TOP = [3, 7, 4]; // what wins after spreading + ranking

// Hop distance from the seeds (breadth-first), used to time the spread.
const hop: number[] = (() => {
  const d = P.map(() => Infinity);
  const q = [...SEEDS];
  SEEDS.forEach((s) => (d[s] = 0));
  while (q.length) {
    const n = q.shift()!;
    for (const [a, b] of E) {
      const m = a === n ? b : b === n ? a : -1;
      if (m >= 0 && d[m] === Infinity) {
        d[m] = d[n] + 1;
        q.push(m);
      }
    }
  }
  return d;
})();

const T = {
  grid: [0, 1.8],
  graph: [0.2, 2.2],
  cue: [1.6, 2.6],
  cueLines: [2.6, 3.4],
  lblCue: [2.2, 3.2],
  seeds: [3.2, 3.7],
  lblSeeds: [3.5, 4.4],
  spread: [4.2, 7.0], // hops 1..3 light up across this span
  lblSpread: [5.0, 6.0],
  ctx: [7.3, 8.3],
  fly: [7.6, 8.8],
  lblCtx: [8.4, 9.3],
  out: [10.8, 11.8],
};

const orbs = makeLoopOrbs(10, "rc", { rMin: 1.6, rMax: 2.4, yMin: -0.6, yMax: 1.4 });
const CUE: Vec3 = [-2.3, -0.55, 0.2];
const CTX: Vec3 = [2.5, -0.2, 0.1];

export const Recall: React.FC<StyleProps> = ({ lineMode, grid, text }) => {
  useFontsReady();
  const { width, height, minDim, t, L, at, span, cyc } = useLoop();
  const camera = swayCamera(width, height, cyc(1), { yaw: -0.2, yawAmp: 0.16, pitch: -0.26, pitchAmp: 0.03, zoom: 0.8, cy: 0.46 });
  const out = 1 - at(T.out);

  const nodes: Stroke3D[] = P.flatMap((p, i) => withIds(octa(p, 0.065), `n${i}`, { weight: 1.1 }));
  const edges: Stroke3D[] = withIds(E.map(([a, b]) => ({ a: P[a], b: P[b] })), "e", { weight: 0.75, opacity: 0.7 });

  // Upright sheets for the cue (left) and the context window (right).
  const upright = (c: Vec3, k = 0) => planar([c[0] + k * 0.13, c[1] + k * 0.13, c[2]], [0.97, 0, -0.25], [0, 1, 0]);
  const cueSheet: Stroke3D[] = withIds(sheet(upright(CUE), 0.55, 0.7, [0.8, 0.5]), "cue");
  const ctxSheets: Stroke3D[] = [0, 1, 2].flatMap((k) =>
    withIds(sheet(upright(CTX, k), 0.5, 0.64, k === 2 ? [0.8, 0.6, 0.7] : [], k === 2), `ctx${k}`),
  );
  const cueLines: Stroke3D[] = SEEDS.map((s, i) => ({ a: [CUE[0] + 0.3, CUE[1], CUE[2]] as Vec3, b: P[s], id: `cl${i}`, weight: 1.1 }));

  // Spread: edges from hop h to hop h+1 draw in accent, outward, in turn.
  const spreadU = (at(T.spread, [0, 3]) as number);
  const spreadEdges: Stroke3D[] = [];
  const spreadP: number[] = [];
  E.forEach(([a, b], i) => {
    const [s, d] = hop[a] <= hop[b] ? [a, b] : [b, a];
    if (hop[d] !== hop[s] + 1 || hop[d] > 3) return;
    spreadEdges.push({ a: P[s], b: P[d], id: `se${i}`, weight: 1.3 });
    spreadP.push(clamp01(spreadU - hop[s]));
  });
  const activation = (i: number) => {
    if (hop[i] === 0) return at(T.seeds);
    return clamp01(spreadU - (hop[i] - 1)) * [1, 0.7, 0.45, 0.28][Math.min(3, hop[i])];
  };

  const showFloor = grid === "floor" || grid === "both";
  const common = { textMode: text, lineMode, minDim, frameWidth: width } as const;
  const flyU = at(T.fly);

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <GlowDefs />
        {(grid === "flat" || grid === "both") && <FlatGrid width={width} height={height} />}
        {showFloor && <FloorGrid camera={camera} minDim={minDim} reveal={at(T.grid) * out} extent={3.2} />}
        <Strokes segments={edges} camera={camera} progress={at(T.graph) * out} mode={lineMode} minDim={minDim} />
        {spreadEdges.map((s, i) => (
          <Strokes key={s.id} segments={[s]} camera={camera} progress={Math.min(spreadP[i], out)} mode={lineMode} minDim={minDim} color={palette.accent} />
        ))}
        <Strokes segments={nodes} camera={camera} progress={at(T.graph) * out} mode={lineMode} minDim={minDim} />
        <Strokes segments={cueSheet} camera={camera} progress={at(T.cue) * out} mode={lineMode} minDim={minDim} />
        <Strokes segments={cueLines} camera={camera} progress={at(T.cueLines) * out} mode={lineMode} minDim={minDim} color={palette.accent} />
        <Strokes segments={ctxSheets} camera={camera} progress={at(T.ctx) * out} mode={lineMode} minDim={minDim} />
        {P.map((p, i) => (
          <Glow key={i} at={p} camera={camera} minDim={minDim} strength={activation(i) * out} size={TOP.includes(i) ? 1.5 : 1} />
        ))}
        {TOP.map((n, k) => {
          const u = clamp01(flyU * 1.4 - k * 0.2);
          const on = u > 0 && u < 1 ? 1 : 0;
          return <Glow key={`fly${k}`} at={lerp3(P[n], [CTX[0] + k * 0.13, CTX[1] + k * 0.13, CTX[2]], u)} camera={camera} minDim={minDim} strength={on} size={1.4} />;
        })}
        <LoopOrbs orbs={orbs} camera={camera} t={t} L={L} fade={at([1.2, 2.6]) * out} minDim={minDim} />
        <TextAt at={[CUE[0], CUE[1] - 0.55, CUE[2]]} camera={camera} text={'"where does the collector run?"'} minDim={minDim}
          opacity={span(T.lblCue, T.out)} textMode={text} scale={0.8} />
        <Label anchor={project(P[3], camera)} text="cue words + names → seeds" side={-1} rise={1} reach={1.5}
          progress={span(T.lblSeeds, [9.6, 10.2])} seed="l-seeds" {...common} />
        <Label anchor={project(P[9], camera)} text="activation spreads along links" side={1} rise={1} reach={1.2}
          progress={span(T.lblSpread, T.out)} seed="l-spread" {...common} />
        <Label anchor={project([CTX[0] + 0.3, CTX[1] - 0.33, CTX[2] - 0.1], camera)} text="best passages → your model's context" side={1} rise={-1} reach={0.6}
          progress={span(T.lblCtx, T.out)} seed="l-ctx" {...common} />
      </svg>
    </AbsoluteFill>
  );
};
