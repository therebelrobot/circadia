import { random } from "remotion";
import type { LineMode } from "../style";
import { sizes } from "../style";

type Pt = { x: number; y: number };

// Builds the 2D points for one stroke from A to B.
// Clean: a straight line. Hand: seeded wobble, a gentle bow, and overshoot at the ends.
// The seed keeps every stroke's wobble identical from frame to frame (no flicker).
export const strokePoints = (
  A: Pt,
  B: Pt,
  mode: LineMode,
  seed: string,
  minDim: number,
): Pt[] => {
  if (mode === "clean") return [A, B];
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const r = (k: string) => random(`${seed}-${k}`);

  const over = sizes.overshoot * minDim;
  const o0 = over * (0.3 + r("o0") * 0.9);
  const o1 = over * (0.3 + r("o1") * 0.9);
  const lenFactor = Math.min(1, len / (minDim * 0.12));
  const amp = sizes.wobble * minDim * lenFactor;
  const bow = (r("bow") - 0.5) * 2 * amp * 1.2;
  const f1 = 0.6 + r("f1") * 0.8;
  const f2 = 1.8 + r("f2") * 1.6;
  const p1 = r("p1") * Math.PI * 2;
  const p2 = r("p2") * Math.PI * 2;

  const n = Math.max(4, Math.ceil(len / 9));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const along = -o0 / len + t * (1 + (o0 + o1) / len);
    const off =
      amp * (0.6 * Math.sin(Math.PI * 2 * f1 * t + p1) + 0.4 * Math.sin(Math.PI * 2 * f2 * t + p2)) +
      bow * Math.sin(Math.PI * t);
    pts.push({ x: A.x + dx * along + nx * off, y: A.y + dy * along + ny * off });
  }
  return pts;
};

// Cuts a polyline at a fraction of its length, for the draw-on effect.
export const trimPoints = (pts: Pt[], progress: number): Pt[] => {
  if (progress >= 1) return pts;
  if (progress <= 0 || pts.length < 2) return [];
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    lens.push(l);
    total += l;
  }
  let remaining = total * progress;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const l = lens[i - 1];
    if (remaining >= l) {
      out.push(pts[i]);
      remaining -= l;
    } else {
      const t = l ? remaining / l : 0;
      out.push({
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      });
      break;
    }
  }
  return out;
};

export const toPath = (pts: Pt[]) =>
  pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
