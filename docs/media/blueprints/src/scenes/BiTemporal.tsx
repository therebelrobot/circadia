import { AbsoluteFill } from "remotion";
import { FlatGrid, FloorGrid } from "../components/Grid";
import { Label } from "../components/Label";
import { Glow, GlowDefs } from "../components/LoopOrbs";
import { Strokes, type Stroke3D } from "../components/Strokes";
import { TextAt } from "../components/TextAt";
import { useFontsReady } from "../fonts";
import { swayCamera, useLoop } from "../lib/loop";
import { lerp3, project, type Vec3 } from "../lib/projection";
import { box, polyline, withIds } from "../lib/shapes";
import { palette, type StyleProps } from "../style";

// docs/SCHEMA.md §4 and docs/ARCHITECTURE.md §8: every fact has two times.
// x = world time (valid::, when it was true); z = system time (at:: / superseded::,
// when the vault believed it). The example is the orchard collector moving hosts.

const Y = -1.1;
const WX = { jun: -1.5, jul: -0.7, aug: 0.1, now: 1.6 };
const SZ = { jun: -1.1, jul: -0.55, aug: 0.0, now: 1.1 }; // +z runs away from the camera: later is further back
const AX_Z = -1.4; // world axis runs along the front edge
const AX_X = -1.8; // system axis runs along the left edge

const T = {
  grid: [0, 1.8],
  axes: [0.3, 1.8],
  lblWorld: [1.6, 2.6],
  lblSystem: [2.1, 3.1],
  oldTile: [2.9, 3.9],
  oldCap: [3.4, 4.2],
  newTile: [4.6, 5.6],
  newCap: [5.2, 6.0],
  strike: [5.4, 6.0],
  probe: [6.4, 7.0],
  lblProbe1: [6.8, 7.7],
  lblProbe1Out: [8.1, 8.5],
  move: [8.4, 9.4],
  lblProbe2: [9.6, 10.5],
  out: [12.8, 13.8],
};

export const BiTemporal: React.FC<StyleProps> = ({ lineMode, grid, text }) => {
  useFontsReady();
  const { width, height, minDim, at, span, cyc } = useLoop();
  const camera = swayCamera(width, height, cyc(1), { yaw: -0.28, yawAmp: 0.12, pitch: -0.62, pitchAmp: 0.03, zoom: 0.86, cy: 0.2 });
  const out = 1 - at(T.out);

  const arrow = (a: Vec3, b: Vec3): Vec3[][] => {
    const d: Vec3 = [b[0] - a[0], 0, b[2] - a[2]];
    const l = Math.hypot(d[0], d[2]);
    const u: Vec3 = [d[0] / l, 0, d[2] / l];
    const n: Vec3 = [-u[2], 0, u[0]];
    const h = 0.11;
    return [
      [a, b],
      [[b[0] - u[0] * h + n[0] * h * 0.6, Y, b[2] - u[2] * h + n[2] * h * 0.6], b, [b[0] - u[0] * h - n[0] * h * 0.6, Y, b[2] - u[2] * h - n[2] * h * 0.6]],
    ];
  };
  const worldAxis = arrow([AX_X, Y, AX_Z], [2.0, Y, AX_Z]);
  const sysAxis = arrow([AX_X, Y, AX_Z], [AX_X, Y, 1.45]);
  const ticks: Vec3[][] = [
    ...[WX.jun, WX.aug, WX.now].map((x) => [[x, Y, AX_Z - 0.06], [x, Y, AX_Z + 0.06]] as Vec3[]),
    ...[SZ.jun, SZ.aug, SZ.now].map((z) => [[AX_X - 0.06, Y, z], [AX_X + 0.06, Y, z]] as Vec3[]),
  ];
  const axes: Stroke3D[] = [...worldAxis, ...sysAxis, ...ticks].flatMap((pl, i) => withIds(polyline(pl), `ax${i}`, { weight: 1.1 }));

  const H = 0.09;
  const oldTile: Stroke3D[] = withIds(box([WX.jun, Y, SZ.jun], [WX.aug, Y + H, SZ.aug]), "old", { opacity: 0.8 });
  const newTile: Stroke3D[] = withIds(box([WX.aug, Y, SZ.aug], [WX.now, Y + H, SZ.now]), "new", { weight: 1.3 });
  // Soft accent fill on top of the current fact.
  const fill = (x0: number, x1: number, z0: number, z1: number) =>
    ([[x0, Y + H, z0], [x1, Y + H, z0], [x1, Y + H, z1], [x0, Y + H, z1]] as Vec3[])
      .map((v) => project(v, camera)).map((p) => `${p.x},${p.y}`).join(" ");

  // The --as-of probe: a pin standing on (world T, system T).
  const moveU = at(T.move);
  const base: Vec3 = lerp3([WX.jul, Y + H, SZ.jul], [1.15, Y + H, 0.7], moveU);
  const top: Vec3 = [base[0], base[1] + 0.6, base[2]];
  const probeP = at(T.probe) * out;
  const probe: Stroke3D[] = [{ a: base, b: top, id: "probe", weight: 1.4 }];

  const showFloor = grid === "floor" || grid === "both";
  const common = { textMode: text, lineMode, minDim, frameWidth: width } as const;
  const tick = (p: Vec3, s: string, o: number, anchor: "middle" | "end" = "middle") => (
    <TextAt key={s + p.join()} at={p} camera={camera} text={s} minDim={minDim} opacity={o} textMode={text} scale={0.62} anchor={anchor} color={palette.grid} />
  );
  const axesO = at([1.2, 2.0]) * out;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <GlowDefs />
        {(grid === "flat" || grid === "both") && <FlatGrid width={width} height={height} />}
        {showFloor && <FloorGrid camera={camera} minDim={minDim} reveal={at(T.grid) * out} extent={3.2} />}
        <polygon points={fill(WX.aug, WX.now, SZ.aug, SZ.now)} fill={palette.accent} opacity={0.1 * at(T.newTile) * out} />
        <Strokes segments={axes} camera={camera} progress={at(T.axes) * out} mode={lineMode} minDim={minDim} />
        <Strokes segments={oldTile} camera={camera} progress={at(T.oldTile) * out} mode={lineMode} minDim={minDim} />
        <Strokes segments={newTile} camera={camera} progress={at(T.newTile) * out} mode={lineMode} minDim={minDim} />
        {tick([WX.jun, Y, AX_Z - 0.22], "jun", axesO)}
        {tick([WX.aug, Y, AX_Z - 0.22], "aug", axesO)}
        {tick([WX.now, Y, AX_Z - 0.22], "now", axesO)}
        {tick([AX_X - 0.14, Y, SZ.jun], "jun", axesO, "end")}
        {tick([AX_X - 0.14, Y, SZ.aug], "aug", axesO, "end")}
        {tick([AX_X - 0.14, Y, SZ.now], "now", axesO, "end")}
        <TextAt at={[(WX.jun + WX.aug) / 2, Y + H, (SZ.jun + SZ.aug) / 2]} camera={camera} text="runs_on old-laptop" minDim={minDim}
          opacity={span(T.oldCap, T.out) * 0.9} textMode={text} scale={0.72} strike={at(T.strike)} />
        <TextAt at={[(WX.aug + WX.now) / 2, Y + H, (SZ.aug + SZ.now) / 2]} camera={camera} text="runs_on pi-cluster" minDim={minDim}
          opacity={span(T.newCap, T.out)} textMode={text} scale={0.72} />
        <Strokes segments={probe} camera={camera} progress={probeP} mode={lineMode} minDim={minDim} color={palette.accent} />
        <Glow at={base} camera={camera} minDim={minDim} strength={probeP} size={1.5} />
        <Label anchor={project([2.0, Y, AX_Z], camera)} text="world time: when it was true" side={1} rise={-1} reach={0.6}
          progress={span(T.lblWorld, T.out)} seed="l-world" {...common} />
        <Label anchor={project([AX_X, Y, 1.45], camera)} text="system time: when we believed it" side={-1} rise={1} reach={0.6}
          progress={span(T.lblSystem, T.out)} seed="l-sys" {...common} />
        <Label anchor={project(top, camera)} text="--as-of July → old-laptop" side={-1} rise={1} reach={0.9}
          progress={span(T.lblProbe1, T.lblProbe1Out)} seed="l-p1" {...common} />
        <Label anchor={project(top, camera)} text="now → pi-cluster" side={1} rise={1} reach={0.9}
          progress={span(T.lblProbe2, T.out)} seed="l-p2" {...common} />
      </svg>
    </AbsoluteFill>
  );
};
