import { AbsoluteFill } from "remotion";
import { FlatGrid, FloorGrid } from "../components/Grid";
import { Label } from "../components/Label";
import { Glow, GlowDefs, LoopOrbs, makeLoopOrbs } from "../components/LoopOrbs";
import { Strokes, type Stroke3D } from "../components/Strokes";
import { TextAt } from "../components/TextAt";
import { useFontsReady } from "../fonts";
import { clamp01, swayCamera, useLoop } from "../lib/loop";
import { lerp3, project, type Vec3 } from "../lib/projection";
import { box, crescent, dashed, planar, polyline, sheet, withIds } from "../lib/shapes";
import { palette, type StyleProps } from "../style";

// docs/ARCHITECTURE.md §2–3 and ROADMAP Phase 4: "sleep". Episodes are replayed through the
// schema-fit gate; ones that fit become facts that cite their episode, untrusted ones are
// held for a human. One git commit per run.

const Y = -1.1;
const STACK: Vec3 = [-2.0, -0.55, 0];
const GATE_X = 0;
const NOTE: Vec3 = [2.0, -0.35, 0];
const TRAY: Vec3 = [0, Y, -0.95]; // in front of the gate (−z is toward the camera)
const CW = 0.4;
const CH = 0.5;

const T = {
  grid: [0, 1.6],
  stack: [0.3, 1.8],
  gate: [0.8, 2.2],
  note: [1.2, 2.6],
  moon: [0.4, 1.8],
  lblEpisodes: [1.9, 2.8],
  card1: [3.0, 4.6],
  fact1: [4.5, 5.0],
  lblGate: [3.4, 4.3],
  card2: [5.0, 6.6],
  fact2: [6.5, 7.0],
  lblFacts: [6.8, 7.7],
  card3: [7.4, 8.3],
  drop3: [8.7, 9.5],
  lblTray: [9.3, 10.2],
  lblCommit: [10.2, 11.0],
  out: [12.8, 13.8],
};

const orbs = makeLoopOrbs(9, "sl", { rMin: 1.8, rMax: 2.6, yMin: 0.2, yMax: 1.5 });

const slot = (i: number): Vec3 => [STACK[0] + i * 0.07, STACK[1] + i * 0.05, STACK[2] + i * 0.12];
const cardAt = (c: Vec3) => planar(c, [1, 0, 0], [0, 1, 0]);

// Where a travelling card is at time progress u (0 = its stack slot, 1 = the note).
const travel = (from: Vec3, u: number, stopAtGate = false): Vec3 => {
  const gate: Vec3 = [GATE_X, -0.35, -0.02];
  if (u < 0.5 || stopAtGate) {
    const k = stopAtGate ? u : u / 0.5;
    const p = lerp3(from, gate, k);
    return [p[0], p[1] + Math.sin(Math.PI * k) * 0.25, p[2]];
  }
  const k = (u - 0.5) / 0.5;
  const p = lerp3(gate, [NOTE[0] - 0.05, NOTE[1] - 0.1, NOTE[2] - 0.05], k);
  return [p[0], p[1] + Math.sin(Math.PI * k) * 0.25, p[2]];
};

export const Sleep: React.FC<StyleProps> = ({ lineMode, grid, text }) => {
  useFontsReady();
  const { width, height, minDim, t, L, at, span, cyc } = useLoop();
  const camera = swayCamera(width, height, cyc(1), { yaw: -0.2, yawAmp: 0.14, pitch: -0.24, pitchAmp: 0.02, zoom: 0.78, cy: 0.52 });
  const out = 1 - at(T.out);
  const common = { textMode: text, lineMode, minDim, frameWidth: width } as const;
  const S = (segs: Stroke3D[], p: number, color?: string) => (
    <Strokes segments={segs} camera={camera} progress={p} mode={lineMode} minDim={minDim} color={color} />
  );

  // The gate: a doorway-like frame the episodes pass through.
  const gw = 0.55, gh = 0.8, gd = 0.07, gy = -0.35;
  const gate: Stroke3D[] = withIds(
    [
      ...box([GATE_X - gw, gy - gh, -gd], [GATE_X - gw + 0.1, gy + gh, gd]),
      ...box([GATE_X + gw - 0.1, gy - gh, -gd], [GATE_X + gw, gy + gh, gd]),
      ...box([GATE_X - gw, gy + gh, -gd], [GATE_X + gw, gy + gh + 0.1, gd]),
    ],
    "gate",
  );
  const note: Stroke3D[] = withIds(sheet(cardAt(NOTE), 0.95, 1.25, [0.5]), "note", { weight: 1.2 });
  const factLine = (k: number): Stroke3D[] =>
    withIds([{ a: [NOTE[0] - 0.33, NOTE[1] - 0.2 - k * 0.16, NOTE[2]], b: [NOTE[0] + 0.3 - k * 0.08, NOTE[1] - 0.2 - k * 0.16, NOTE[2]] }], `fact${k}`, { weight: 1.3 });
  const tray: Stroke3D[] = withIds(box([TRAY[0] - 0.55, Y, TRAY[2] - 0.35], [TRAY[0] + 0.55, Y + 0.14, TRAY[2] + 0.35]), "tray");

  // Moon: rises and sets once per loop, fading at both ends so the loop is seamless.
  const mu = t / L;
  const moonC: Vec3 = [-2.1 + 4.2 * mu, 1.1 + 0.35 * Math.sin(Math.PI * mu), 0.6];
  const moonFade = at(T.moon) * (1 - at([L - 1.6, L - 0.3]));
  const moon: Stroke3D[] = withIds(crescent(planar(moonC, [1, 0, 0], [0, 1, 0]), 0.17), "moon", { weight: 1.1, opacity: moonFade });

  // Cards: 0 and 1 fit and become facts; 2 is untrusted and is held for review.
  const u1 = at(T.card1), u2 = at(T.card2), u3 = at(T.card3), d3 = at(T.drop3);
  const cardSegs = (c: Vec3, id: string, untrusted = false): Stroke3D[] => {
    const f = cardAt(c);
    if (!untrusted) return withIds(sheet(f, CW, CH, [0.7, 0.5], false), id);
    const corners: Vec3[] = [f(-CW / 2, -CH / 2), f(-CW / 2, CH / 2), f(CW / 2, CH / 2), f(CW / 2, -CH / 2)];
    return withIds(
      [0, 1, 2, 3].flatMap((i) => dashed(corners[i], corners[(i + 1) % 4], 5, 0.6))
        .concat(polyline([f(-CW * 0.3, CH * 0.15), f(CW * 0.25, CH * 0.15)]), polyline([f(-CW * 0.3, -CH * 0.05), f(CW * 0.1, -CH * 0.05)])),
      id,
    );
  };
  const c3pos: Vec3 = d3 > 0 ? lerp3(travel(slot(2), 1, true), [TRAY[0], Y + 0.14 + CH / 2 * 0.2, TRAY[2]], d3) : travel(slot(2), u3, true);
  const vis = (u: number) => (u >= 1 ? 0 : 1);

  const showFloor = grid === "floor" || grid === "both";

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <GlowDefs />
        {(grid === "flat" || grid === "both") && <FlatGrid width={width} height={height} />}
        {showFloor && <FloorGrid camera={camera} minDim={minDim} reveal={at(T.grid) * out} extent={3.4} />}
        {S(tray, at(T.gate) * out)}
        {S(gate, at(T.gate) * out)}
        {S(note, at(T.note) * out)}
        {S(factLine(0), at(T.fact1) * out, palette.accent)}
        {S(factLine(1), at(T.fact2) * out, palette.accent)}
        {S(moon, moonFade > 0 ? 1 : 0)}
        {S(cardSegs(travel(slot(0), u1), "c1"), at(T.stack) * vis(u1) * out)}
        {S(cardSegs(travel(slot(1), u2), "c2"), at(T.stack) * vis(u2) * out)}
        {S(cardSegs(c3pos, "c3", true), at(T.stack) * out)}
        <Glow at={[NOTE[0], NOTE[1] - 0.2, NOTE[2]]} camera={camera} minDim={minDim} strength={clamp01(span(T.fact1, [5.0, 5.8]))} size={2} />
        <Glow at={[NOTE[0], NOTE[1] - 0.36, NOTE[2]]} camera={camera} minDim={minDim} strength={clamp01(span(T.fact2, [7.0, 7.8]))} size={2} />
        <Glow at={[GATE_X, -0.35, 0]} camera={camera} minDim={minDim} strength={0.8 * clamp01(span([8.0, 8.4], [8.6, 9.2]))} size={2.4} />
        <LoopOrbs orbs={orbs} camera={camera} t={t} L={L} fade={at([1, 2.5]) * out} minDim={minDim} />
        <Label anchor={project([STACK[0] - 0.1, STACK[1] + CH / 2, STACK[2]], camera)} text="episodes: written now, never edited" side={-1} rise={1} reach={0.5}
          progress={span(T.lblEpisodes, T.out)} seed="l-ep" {...common} />
        <Label anchor={project([GATE_X - gw, gy + gh + 0.1, 0], camera)} text="schema-fit gate" side={-1} rise={1} reach={0.9}
          progress={span(T.lblGate, T.out)} seed="l-gate" {...common} />
        <Label anchor={project([NOTE[0] + 0.47, NOTE[1] - 0.4, NOTE[2]], camera)} text="facts that cite their episode" side={1} rise={-1} reach={0.5}
          progress={span(T.lblFacts, T.out)} seed="l-facts" {...common} />
        <Label anchor={project([TRAY[0] + 0.55, Y + 0.14, TRAY[2]], camera)} text="untrusted: held for your review" side={1} rise={-1} reach={0.8}
          progress={span(T.lblTray, T.out)} seed="l-tray" {...common} />
        <TextAt at={[-1.5, 1.3, 0.3]} camera={camera} text="one git commit per night" minDim={minDim} opacity={span(T.lblCommit, T.out)} textMode={text} scale={1} />
      </svg>
    </AbsoluteFill>
  );
};
