import type { Vec3 } from "./projection";

export type Segment = { a: Vec3; b: Vec3 };

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

// A flat 2D drawing placed in 3D: point (u, v) maps to origin + u·U + v·V.
export const planar = (origin: Vec3, U: Vec3, V: Vec3) => (u: number, v: number): Vec3 =>
  add(origin, add(mul(U, u), mul(V, v)));

const polyInto = (segs: Segment[], pts: Vec3[]) => {
  for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1] });
};

// A sheet of paper: outline with a folded top-right corner and a few "text" lines.
// Lines are fixed in count per sheet so ids stay stable across frames.
// w, h in scene units; the sheet spans u ∈ [-w/2, w/2], v ∈ [-h/2, h/2].
export const sheet = (
  at: (u: number, v: number) => Vec3,
  w: number,
  h: number,
  lineLengths: number[] = [0.75, 0.6, 0.8, 0.45],
  title = true,
): Segment[] => {
  const segs: Segment[] = [];
  const f = Math.min(w, h) * 0.22; // folded corner
  const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2;
  polyInto(segs, [at(x0, y0), at(x0, y1), at(x1 - f, y1), at(x1, y1 - f), at(x1, y0), at(x0, y0)]);
  polyInto(segs, [at(x1 - f, y1), at(x1 - f, y1 - f), at(x1, y1 - f)]);
  const pad = w * 0.14;
  const usable = w - pad * 2;
  let y = y1 - h * 0.2;
  if (title) {
    segs.push({ a: at(x0 + pad, y), b: at(x0 + pad + usable * 0.45, y) });
    y -= h * 0.17;
  }
  for (const len of lineLengths) {
    segs.push({ a: at(x0 + pad, y), b: at(x0 + pad + usable * len, y) });
    y -= h * 0.13;
  }
  return segs;
};

// A small octahedron: reads as a node or a gem in wireframe.
export const octa = (c: Vec3, r: number): Segment[] => {
  const v: Vec3[] = [
    [c[0] + r, c[1], c[2]], [c[0] - r, c[1], c[2]],
    [c[0], c[1] + r, c[2]], [c[0], c[1] - r, c[2]],
    [c[0], c[1], c[2] + r], [c[0], c[1], c[2] - r],
  ];
  const e: [number, number][] = [
    [0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5],
    [2, 4], [4, 3], [3, 5], [5, 2],
  ];
  return e.map(([i, j]) => ({ a: v[i], b: v[j] }));
};

// A circle in the plane spanned by U and V.
export const ring = (at: (u: number, v: number) => Vec3, r: number, steps = 32, from = 0, to = Math.PI * 2): Segment[] => {
  const segs: Segment[] = [];
  for (let i = 0; i < steps; i++) {
    const q0 = from + ((to - from) * i) / steps;
    const q1 = from + ((to - from) * (i + 1)) / steps;
    segs.push({ a: at(r * Math.cos(q0), r * Math.sin(q0)), b: at(r * Math.cos(q1), r * Math.sin(q1)) });
  }
  return segs;
};

// A crescent moon, lit on its -u side, in the plane spanned by U and V.
export const crescent = (at: (u: number, v: number) => Vec3, r: number, steps = 20): Segment[] => {
  const segs: Segment[] = [];
  // outer arc: the lit limb, from the top cusp round the left to the bottom cusp
  segs.push(...ring(at, r, steps, Math.PI / 2, (3 * Math.PI) / 2));
  // inner arc: part of a larger circle centred to the right, through both cusps
  const k = r * 0.7;
  const R = Math.sqrt(r * r + k * k);
  const q = Math.atan2(r, -k); // angle of the top cusp seen from the inner centre
  const inner = (u: number, v: number) => at(u + k, v);
  segs.push(...ring(inner, R, steps, q, Math.PI * 2 - q));
  return segs;
};

// A box outline: two rectangles joined at the corners. Used for tiles and trays.
export const box = (min: Vec3, max: Vec3): Segment[] => {
  const segs: Segment[] = [];
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  for (const y of [y0, y1]) {
    polyInto(segs, [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [x0, y, z0]]);
  }
  for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as const) segs.push({ a: [x, y0, z], b: [x, y1, z] });
  return segs;
};

// A dashed line as separate short segments (fixed count, so ids stay stable).
export const dashed = (a: Vec3, b: Vec3, dashes = 8, duty = 0.55): Segment[] => {
  const segs: Segment[] = [];
  for (let i = 0; i < dashes; i++) {
    const t0 = i / dashes;
    const t1 = t0 + duty / dashes;
    const p = (t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    segs.push({ a: p(t0), b: p(t1) });
  }
  return segs;
};

// A quadratic arc from a to b bowing through `lift` above their midpoint.
export const arcPoints = (a: Vec3, b: Vec3, lift: number, steps = 24): Vec3[] => {
  const m: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + lift, (a[2] + b[2]) / 2];
  const pts: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s = 1 - t;
    pts.push([
      s * s * a[0] + 2 * s * t * m[0] + t * t * b[0],
      s * s * a[1] + 2 * s * t * m[1] + t * t * b[1],
      s * s * a[2] + 2 * s * t * m[2] + t * t * b[2],
    ]);
  }
  return pts;
};

export const polyline = (pts: Vec3[]): Segment[] => {
  const segs: Segment[] = [];
  polyInto(segs, pts);
  return segs;
};

export const withIds = (segs: Segment[], prefix: string, extra: { weight?: number; opacity?: number } = {}) =>
  segs.map((s, i) => ({ ...s, id: `${prefix}-${i}`, ...extra }));
