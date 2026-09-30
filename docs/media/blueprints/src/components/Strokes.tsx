import { random } from "remotion";
import { depthRatio, project, type Camera, type Vec3 } from "../lib/projection";
import { strokePoints, toPath, trimPoints } from "../lib/sketch";
import { palette, sizes, type LineMode } from "../style";

export type Stroke3D = { a: Vec3; b: Vec3; id: string; weight?: number; opacity?: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Draws 3D segments as 2D strokes. Near lines are thicker and brighter, far lines thinner and dimmer.
// progress 0→1 grows every stroke from its start point at the same time ("all at once" draw-on).
export const Strokes: React.FC<{
  segments: Stroke3D[];
  camera: Camera;
  progress: number;
  mode: LineMode;
  minDim: number;
  color?: string;
}> = ({ segments, camera, progress, mode, minDim, color = palette.line }) => {
  if (progress <= 0) return null;
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      {segments.map((s) => {
        const A = project(s.a, camera);
        const B = project(s.b, camera);
        const depth = (depthRatio(A, camera) + depthRatio(B, camera)) / 2;
        const jitter = mode === "hand" ? 0.88 + random(`${s.id}-w`) * 0.24 : 1;
        const width = sizes.lineWidth * minDim * (s.weight ?? 1) * jitter * clamp(depth ** 1.8, 0.45, 2);
        const opacity = (s.opacity ?? 1) * clamp(0.35 + 0.65 * ((depth - 0.78) / 0.44), 0.3, 1);
        const main = trimPoints(strokePoints(A, B, mode, s.id, minDim), progress);
        return (
          <g key={s.id} stroke={color}>
            <path d={toPath(main)} strokeWidth={width} opacity={opacity} />
            {mode === "hand" && (
              <path
                d={toPath(trimPoints(strokePoints(A, B, mode, `${s.id}-ghost`, minDim), progress))}
                strokeWidth={width * 0.55}
                opacity={opacity * 0.35}
              />
            )}
          </g>
        );
      })}
    </g>
  );
};
