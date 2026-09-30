import { random } from "remotion";
import { depthRatio, project, type Camera, type Vec3 } from "../lib/projection";
import { palette, sizes } from "../style";

// Loop-safe orbs. Same look as the house Orbs (pulse, glow, short fading trail), but every
// motion is a whole number of cycles per loop, so frame 0 and the last frame match.

type OrbSpec = {
  radius: number; height: number; k: number; phase: number;
  bob: number; bobK: number; size: number; pulseK: number;
};

export const makeLoopOrbs = (
  count: number,
  seed = "orb",
  o: { rMin?: number; rMax?: number; yMin?: number; yMax?: number } = {},
): OrbSpec[] =>
  Array.from({ length: count }, (_, i) => {
    const r = (k: string) => random(`${seed}-${i}-${k}`);
    const rMin = o.rMin ?? 1.0;
    const rMax = o.rMax ?? 1.9;
    const yMin = o.yMin ?? -0.8;
    const yMax = o.yMax ?? 1.2;
    return {
      radius: rMin + r("r") * (rMax - rMin),
      height: yMin + r("y") * (yMax - yMin),
      k: r("d") < 0.5 ? -1 : 1, // one orbit per loop, either direction
      phase: r("p") * Math.PI * 2,
      bob: 0.06 + r("b") * 0.12,
      bobK: 1 + Math.floor(r("bk") * 3),
      size: 0.8 + r("z") * 0.8,
      pulseK: 2 + Math.floor(r("pk") * 3),
    };
  });

const orbPos = (o: OrbSpec, t: number, L: number, c: Vec3): Vec3 => {
  const q = o.phase + (Math.PI * 2 * o.k * t) / L;
  return [
    c[0] + o.radius * Math.cos(q),
    c[1] + o.height + Math.sin((Math.PI * 2 * o.bobK * t) / L + o.phase) * o.bob,
    c[2] + o.radius * Math.sin(q),
  ];
};

export const LoopOrbs: React.FC<{
  orbs: OrbSpec[];
  camera: Camera;
  t: number;
  L: number;
  fade: number;
  minDim: number;
  center?: Vec3;
  gradientId?: string;
}> = ({ orbs, camera, t, L, fade, minDim, center = [0, 0, 0], gradientId = "orbGlow" }) => {
  if (fade <= 0) return null;
  const trailSteps = 12;
  const trailDt = 0.035;
  const drawn = orbs
    .map((o, i) => ({ o, i, p: project(orbPos(o, t, L, center), camera) }))
    .sort((a, b) => b.p.z - a.p.z);
  return (
    <g>
      {drawn.map(({ o, i, p }) => {
        const depth = depthRatio(p, camera);
        const pulse = 0.5 + 0.5 * Math.sin((Math.PI * 2 * o.pulseK * t) / L + o.phase);
        const r = sizes.orb * minDim * o.size * depth * (0.85 + 0.3 * pulse);
        const vis = fade * Math.max(0.3, Math.min(1, 0.35 + 0.65 * ((depth - 0.75) / 0.5)));
        const trail: React.ReactNode[] = [];
        let prev = p;
        for (let j = 1; j <= trailSteps; j++) {
          const q = project(orbPos(o, t - j * trailDt, L, center), camera);
          const k = 1 - j / (trailSteps + 1);
          trail.push(
            <line key={j} x1={prev.x} y1={prev.y} x2={q.x} y2={q.y}
              stroke={palette.accent} strokeWidth={r * 1.1 * k} strokeLinecap="round" opacity={0.4 * k * vis} />,
          );
          prev = q;
        }
        return (
          <g key={i}>
            {trail}
            <circle cx={p.x} cy={p.y} r={r * 5} fill={`url(#${gradientId})`} opacity={vis * (0.6 + 0.4 * pulse)} />
            <circle cx={p.x} cy={p.y} r={r} fill={palette.accentCore} opacity={vis} />
          </g>
        );
      })}
    </g>
  );
};

// A glow at a 3D point: for "this node is active" and for things travelling along edges.
export const Glow: React.FC<{ at: Vec3; camera: Camera; minDim: number; strength: number; size?: number; gradientId?: string }> = ({
  at, camera, minDim, strength, size = 1, gradientId = "orbGlow",
}) => {
  if (strength <= 0.01) return null;
  const p = project(at, camera);
  const r = sizes.orb * minDim * size * depthRatio(p, camera);
  return (
    <g>
      <circle cx={p.x} cy={p.y} r={r * 6} fill={`url(#${gradientId})`} opacity={strength} />
      <circle cx={p.x} cy={p.y} r={r} fill={palette.accentCore} opacity={strength} />
    </g>
  );
};

// The glow gradient shared by orbs and Glow. Render once per scene, before anything glows.
export const GlowDefs: React.FC<{ id?: string }> = ({ id = "orbGlow" }) => (
  <defs>
    <radialGradient id={id}>
      <stop offset="0%" stopColor={palette.accent} stopOpacity={0.6} />
      <stop offset="35%" stopColor={palette.accent} stopOpacity={0.16} />
      <stop offset="100%" stopColor={palette.accent} stopOpacity={0} />
    </radialGradient>
  </defs>
);
