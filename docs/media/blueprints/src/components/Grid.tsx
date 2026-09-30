import { depthRatio, project, type Camera } from "../lib/projection";
import { palette, sizes } from "../style";

// Flat drafting grid fixed to the screen, like the paper itself.
export const FlatGrid: React.FC<{ width: number; height: number }> = ({ width, height }) => {
  const minDim = Math.min(width, height);
  const step = minDim * sizes.flatGridStep;
  const cx = width / 2;
  const cy = height / 2;
  const lines: React.ReactNode[] = [];
  const nx = Math.ceil(width / 2 / step);
  const ny = Math.ceil(height / 2 / step);
  for (let i = -nx; i <= nx; i++) {
    const x = cx + i * step;
    lines.push(<line key={`v${i}`} x1={x} y1={0} x2={x} y2={height} opacity={i % 4 === 0 ? 0.13 : 0.06} />);
  }
  for (let j = -ny; j <= ny; j++) {
    const y = cy + j * step;
    lines.push(<line key={`h${j}`} x1={0} y1={y} x2={width} y2={y} opacity={j % 4 === 0 ? 0.13 : 0.06} />);
  }
  return (
    <g stroke={palette.grid} strokeWidth={Math.max(1, minDim * 0.0009)}>
      {lines}
    </g>
  );
};

// Grid on the floor plane. Rotates with the camera and spreads outward from the center as it appears.
export const FloorGrid: React.FC<{
  camera: Camera;
  minDim: number;
  reveal: number; // 0→1
  y?: number;
  extent?: number;
  step?: number;
}> = ({ camera, minDim, reveal, y = -1.1, extent = 3, step = 0.3 }) => {
  if (reveal <= 0) return null;
  const pieces = 18;
  const out: React.ReactNode[] = [];
  const n = Math.round(extent / step);
  for (let i = -n; i <= n; i++) {
    const c = i * step;
    for (const axis of ["x", "z"] as const) {
      for (let k = 0; k < pieces; k++) {
        const u0 = -extent + (2 * extent * k) / pieces;
        const u1 = -extent + (2 * extent * (k + 1)) / pieces;
        const um = (u0 + u1) / 2;
        const r = Math.hypot(c, um);
        const edgeFade = Math.max(0, 1 - r / extent) ** 1.4;
        const revealFade = Math.max(0, Math.min(1, (reveal * extent * 1.15 - r) / 0.5));
        const op = 0.42 * edgeFade * revealFade;
        if (op < 0.01) continue;
        const A = project(axis === "x" ? [c, y, u0] : [u0, y, c], camera);
        const B = project(axis === "x" ? [c, y, u1] : [u1, y, c], camera);
        const depth = (depthRatio(A, camera) + depthRatio(B, camera)) / 2;
        out.push(
          <line
            key={`${axis}${i}-${k}`}
            x1={A.x} y1={A.y} x2={B.x} y2={B.y}
            strokeWidth={sizes.lineWidth * minDim * 0.5 * Math.max(0.4, depth ** 1.8)}
            opacity={op}
          />,
        );
      }
    }
  }
  return (
    <g stroke={palette.grid} strokeLinecap="round">
      {out}
    </g>
  );
};
