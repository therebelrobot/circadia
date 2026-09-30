import { AbsoluteFill } from "remotion";
import { FlatGrid, FloorGrid } from "../components/Grid";
import { Glow, GlowDefs, LoopOrbs, makeLoopOrbs } from "../components/LoopOrbs";
import { Strokes, type Stroke3D } from "../components/Strokes";
import { useFontsReady } from "../fonts";
import { swayCamera, useLoop } from "../lib/loop";
import { NODES, edgeSegments, nodeSegments, pointerSegments, vaultSegments } from "../lib/memory";
import { lerp3, type Vec3 } from "../lib/projection";
import { strokePoints, toPath } from "../lib/sketch";
import { crescent, planar, withIds } from "../lib/shapes";
import { fonts, palette, sizes, type StyleProps } from "../style";

// README header. Always fully drawn (a banner should never be blank), with a slow camera
// sway, drifting orbs, and one "recall" pulse that walks the index each loop.

const orbs = makeLoopOrbs(14, "banner", { rMin: 1.3, rMax: 2.3, yMin: -0.6, yMax: 1.4 });

// The pulse's route through the index: node ids, walked once per loop.
const ROUTE = [0, 1, 6, 4, 5, 2, 1, 0];

export const Banner: React.FC<StyleProps> = ({ lineMode, grid, text }) => {
  useFontsReady();
  const { width, height, minDim, t, L, cyc } = useLoop();
  const camera = swayCamera(width, height, cyc(1), {
    yaw: -0.3, yawAmp: 0.2, pitch: -0.3, pitchAmp: 0.025, zoom: 0.95, cx: 0.7, cy: 0.44,
  });

  const vault: Stroke3D[] = vaultSegments().flatMap((s, i) => withIds(s, `sheet${i}`));
  const nodes: Stroke3D[] = nodeSegments().flatMap((s, i) => withIds(s, `node${i}`, { weight: 1.2 }));
  const edges: Stroke3D[] = withIds(edgeSegments(), "edge", { weight: 0.8, opacity: 0.75 });
  const pointers: Stroke3D[] = pointerSegments().flatMap((s, i) => withIds(s, `ptr${i}`, { weight: 0.6, opacity: 0.6 }));
  const moon: Stroke3D[] = withIds(crescent(planar([1.7, 1.05, -0.5], [1, 0, 0], [0, 1, 0]), 0.2), "moon", { weight: 1.1 });

  // Pulse position along ROUTE: u runs 0→1 over the loop.
  const u = (t / L) * (ROUTE.length - 1);
  const leg = Math.min(ROUTE.length - 2, Math.floor(u));
  const f = u - leg;
  const ease = f * f * (3 - 2 * f);
  const pulseAt: Vec3 = lerp3(NODES[ROUTE[leg]].p, NODES[ROUTE[leg + 1]].p, ease);
  // Nodes flare as the pulse passes through them.
  const flare = (i: number) => {
    let best = 0;
    ROUTE.forEach((n, k) => {
      if (n !== i) return;
      const d = Math.abs(u - k);
      best = Math.max(best, Math.max(0, 1 - d / 0.6));
    });
    return best;
  };

  const showFloor = grid === "floor" || grid === "both";
  const titleSize = minDim * 0.19;
  const tx = width * 0.07;
  const ty = height * 0.46;
  const underline = strokePoints({ x: tx, y: ty + titleSize * 0.28 }, { x: tx + titleSize * 3.9, y: ty + titleSize * 0.24 }, lineMode, "title-ul", minDim);

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <GlowDefs />
        {(grid === "flat" || grid === "both") && <FlatGrid width={width} height={height} />}
        {showFloor && <FloorGrid camera={camera} minDim={minDim} reveal={1} extent={2.6} />}
        <Strokes segments={vault} camera={camera} progress={1} mode={lineMode} minDim={minDim} />
        <Strokes segments={pointers} camera={camera} progress={1} mode={lineMode} minDim={minDim} color={palette.accent} />
        <Strokes segments={edges} camera={camera} progress={1} mode={lineMode} minDim={minDim} />
        <Strokes segments={nodes} camera={camera} progress={1} mode={lineMode} minDim={minDim} />
        <Strokes segments={moon} camera={camera} progress={1} mode={lineMode} minDim={minDim} />
        {NODES.map((n, i) => (
          <Glow key={i} at={n.p} camera={camera} minDim={minDim} strength={0.9 * flare(i)} size={1.3} />
        ))}
        <LoopOrbs orbs={orbs} camera={camera} t={t} L={L} fade={1} minDim={minDim} center={[0, 0, 0]} />
        <Glow at={pulseAt} camera={camera} minDim={minDim} strength={1} size={2.4} />
        {text !== "none" && (
          <g>
            <text x={tx} y={ty} fill={palette.line} fontFamily={fonts.handwritten} fontSize={titleSize}
              dominantBaseline="alphabetic">Circadia</text>
            <path d={toPath(underline)} stroke={palette.accent} strokeWidth={sizes.lineWidth * minDim * 1.6}
              fill="none" strokeLinecap="round" />
            <text x={tx} y={ty + titleSize * 0.75} fill={palette.line} fontFamily={fonts.handwritten}
              fontSize={minDim * 0.065} opacity={0.95}>agent memory that sleeps on it</text>
            <text x={tx} y={ty + titleSize * 1.25} fill={palette.grid} fontFamily={fonts.technical} fontWeight={500}
              fontSize={minDim * 0.03} letterSpacing="0.14em">MARKDOWN VAULT · GRAPH INDEX · MCP</text>
          </g>
        )}
      </svg>
    </AbsoluteFill>
  );
};
