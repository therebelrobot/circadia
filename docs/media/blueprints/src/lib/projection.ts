export type Vec3 = [number, number, number];
export type Projected = { x: number; y: number; z: number; scale: number };

export type Camera = {
  yaw: number;
  pitch: number;
  cx: number;
  cy: number;
  focal: number;
  distance: number;
};

// Frames the scene the same way at any aspect ratio.
export const makeCamera = (
  width: number,
  height: number,
  yaw: number,
  pitch: number,
  zoom = 1,
): Camera => {
  const minDim = Math.min(width, height);
  const portraitBoost = height > width ? 1.3 : 1;
  return {
    yaw,
    pitch,
    cx: width / 2,
    cy: height / 2 + minDim * 0.03,
    focal: minDim * 1.39 * portraitBoost * zoom,
    distance: 5,
  };
};

// Rotate by yaw (around Y) and pitch (around X), then perspective-project.
// Negative pitch = camera looking down at the floor.
export const project = ([x, y, z]: Vec3, c: Camera): Projected => {
  const x1 = x * Math.cos(c.yaw) + z * Math.sin(c.yaw);
  const z1 = -x * Math.sin(c.yaw) + z * Math.cos(c.yaw);
  const y1 = y * Math.cos(c.pitch) - z1 * Math.sin(c.pitch);
  const z2 = y * Math.sin(c.pitch) + z1 * Math.cos(c.pitch);
  const scale = c.focal / (z2 + c.distance);
  return { x: c.cx + x1 * scale, y: c.cy - y1 * scale, z: z2, scale };
};

// 1 = at the reference depth. Above 1 is nearer, below is farther.
export const depthRatio = (p: Projected, c: Camera) => p.scale / (c.focal / c.distance);

export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
