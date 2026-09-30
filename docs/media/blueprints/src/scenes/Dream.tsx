import { AbsoluteFill } from "remotion";
import { FlatGrid, FloorGrid } from "../components/Grid";
import { Label } from "../components/Label";
import { Glow, GlowDefs, LoopOrbs, makeLoopOrbs } from "../components/LoopOrbs";
import { Strokes, type Stroke3D } from "../components/Strokes";
import { useFontsReady } from "../fonts";
import { clamp01, swayCamera, useLoop } from "../lib/loop";
import { project, type Vec3 } from "../lib/projection";
import { arcPoints, crescent, octa, planar, withIds } from "../lib/shapes";
import { palette, type StyleProps } from "../style";

// docs/ARCHITECTURE.md §10 and RFC-0001: the REM pass. A recently active note is paired
// with a distant, older one; the model may propose a link between them. The result is a
// candidate, never a fact: it enters recall at weight 0, is read once, and only a human
// in `circadia review` can turn it into a fact.

const RECENT: Vec3[] = [[-1.5, -0.2, -0.3], [-1.0, 0.3, -0.55], [-0.85, -0.45, 0.1], [-1.35, 0.45, 0.25], [-0.55, 0.05, -0.2]];
const OLD: Vec3[] = [[0.9, -0.3, 0.55], [1.4, 0.2, 0.3], [1.15, -0.55, 1.0], [1.75, -0.2, 0.8], [1.3, 0.55, 0.9]];
const RE: [number, number][] = [[0, 1], [0, 2], [1, 4], [2, 4], [0, 3], [1, 3]];
const OE: [number, number][] = [[0, 1], [0, 2], [1, 3], [2, 3], [1, 4], [3, 4]];
const A = 4; // the recently active note
const B = 1; // the distant partner

const T = {
  grid: [0, 1.6],
  graph: [0.2, 2.0],
  moon: [0.8, 2.0],
  recent: [2.4, 3.0],
  lblRecent: [2.6, 3.5],
  distant: [3.6, 4.2],
  lblDistant: [3.8, 4.7],
  arc: [4.8, 6.0],
  lblCandidate: [5.8, 6.7],
  lblReview: [7.2, 8.1],
  fade: [9.4, 10.4], // read once, then it fades
  out: [10.8, 11.8],
};

const orbs = makeLoopOrbs(10, "dr", { rMin: 1.9, rMax: 2.6, yMin: -0.4, yMax: 1.3 });

export const Dream: React.FC<StyleProps> = ({ lineMode, grid, text }) => {
  useFontsReady();
  const { width, height, minDim, t, L, at, span, cyc } = useLoop();
  const camera = swayCamera(width, height, cyc(1), { yaw: -0.25, yawAmp: 0.16, pitch: -0.27, pitchAmp: 0.02, zoom: 0.95, cy: 0.6 });
  const out = 1 - at(T.out);
  const common = { textMode: text, lineMode, minDim, frameWidth: width } as const;

  const cluster = (pts: Vec3[], es: [number, number][], id: string, opacity: number): Stroke3D[] => [
    ...pts.flatMap((p, i) => withIds(octa(p, 0.07), `${id}n${i}`, { weight: 1.1, opacity })),
    ...withIds(es.map(([a, b]) => ({ a: pts[a], b: pts[b] })), `${id}e`, { weight: 0.8, opacity: opacity * 0.8 }),
  ];
  const recent = cluster(RECENT, RE, "r", 1);
  const old = cluster(OLD, OE, "o", 0.6);
  const moon = withIds(crescent(planar([0.15, 1.25, 0.6], [1, 0, 0], [0, 1, 0]), 0.2), "moon", { weight: 1.1 });

  // The candidate: a dashed arc between the two, drawn in accent.
  const arc = arcPoints(RECENT[A], OLD[B], 0.9, 30);
  const dashes: Stroke3D[] = [];
  for (let i = 0; i < arc.length - 1; i += 2) dashes.push({ a: arc[i], b: arc[i + 1], id: `arc${i}`, weight: 1.2 });
  const arcP = at(T.arc) * (1 - at(T.fade)) * out;

  const showFloor = grid === "floor" || grid === "both";

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <GlowDefs />
        {(grid === "flat" || grid === "both") && <FlatGrid width={width} height={height} />}
        {showFloor && <FloorGrid camera={camera} minDim={minDim} reveal={at(T.grid) * out} extent={3.2} />}
        <Strokes segments={old} camera={camera} progress={at(T.graph) * out} mode={lineMode} minDim={minDim} />
        <Strokes segments={recent} camera={camera} progress={at(T.graph) * out} mode={lineMode} minDim={minDim} />
        <Strokes segments={moon} camera={camera} progress={at(T.moon) * out} mode={lineMode} minDim={minDim} />
        <Strokes segments={dashes} camera={camera} progress={arcP} mode={lineMode} minDim={minDim} color={palette.accent} />
        <Glow at={RECENT[A]} camera={camera} minDim={minDim} strength={at(T.recent) * clamp01(1 - at(T.fade) * 0.7) * out} size={1.8} />
        <Glow at={OLD[B]} camera={camera} minDim={minDim} strength={at(T.distant) * clamp01(1 - at(T.fade) * 0.7) * out} size={1.5} />
        <LoopOrbs orbs={orbs} camera={camera} t={t} L={L} fade={at([1, 2.5]) * out} minDim={minDim} />
        <Label anchor={project(RECENT[A], camera)} text="recently active" side={-1} rise={1} reach={2.8}
          progress={span(T.lblRecent, T.out)} seed="l-rec" {...common} />
        <Label anchor={project(OLD[B], camera)} text="distant, older note" side={1} rise={-1} reach={1.2}
          progress={span(T.lblDistant, T.out)} seed="l-dist" {...common} />
        <Label anchor={project(arc[15], camera)} text="a candidate link, never a fact" side={1} rise={1} reach={1.4}
          progress={span(T.lblCandidate, T.fade)} seed="l-cand" {...common} />
        <Label anchor={project(arc[9], camera)} text="only you can promote it, in review" side={-1} rise={1} reach={1.4}
          progress={span(T.lblReview, T.fade)} seed="l-rev" {...common} />
      </svg>
    </AbsoluteFill>
  );
};
