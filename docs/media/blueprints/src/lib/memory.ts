import type { Vec3 } from "./projection";
import { dashed, octa, planar, sheet, type Segment } from "./shapes";

// The Circadia picture: markdown notes (the vault) lying on the floor, and a sparse index
// of nodes floating above them. Each index node points down at the note it indexes; the
// index holds pointers and associations, never the content.

export const FLOOR = -1.1;

export type SheetSpec = { x: number; z: number; rot: number; lines: number[] };

export const SHEETS: SheetSpec[] = [
  { x: -1.15, z: 0.55, rot: 0.12, lines: [0.8, 0.55, 0.7] },
  { x: -0.05, z: 0.8, rot: -0.08, lines: [0.6, 0.85, 0.5] },
  { x: 1.1, z: 0.5, rot: 0.18, lines: [0.75, 0.65, 0.8] },
  { x: -0.85, z: -0.55, rot: -0.15, lines: [0.7, 0.5, 0.75] },
  { x: 0.3, z: -0.45, rot: 0.06, lines: [0.85, 0.6, 0.45] },
  { x: 1.3, z: -0.65, rot: -0.1, lines: [0.55, 0.8, 0.6] },
];

const SHEET_W = 0.62;
const SHEET_H = 0.78;

const sheetFrame = (s: SheetSpec) =>
  planar(
    [s.x, FLOOR + 0.004, s.z],
    [Math.cos(s.rot), 0, -Math.sin(s.rot)],
    [-Math.sin(s.rot), 0, -Math.cos(s.rot)], // +v runs away from the camera
  );

export const sheetCenter = (i: number): Vec3 => [SHEETS[i].x, FLOOR, SHEETS[i].z];

export const vaultSegments = (): Segment[][] => SHEETS.map((s) => sheet(sheetFrame(s), SHEET_W, SHEET_H, s.lines));

// Index nodes: [x, y, z] plus the sheet each one points at.
export const NODES: { p: Vec3; sheet: number }[] = [
  { p: [-1.05, 0.25, 0.45], sheet: 0 },
  { p: [-0.1, 0.55, 0.7], sheet: 1 },
  { p: [1.0, 0.3, 0.4], sheet: 2 },
  { p: [-0.75, 0.75, -0.5], sheet: 3 },
  { p: [0.35, 0.95, -0.4], sheet: 4 },
  { p: [1.25, 0.65, -0.6], sheet: 5 },
  { p: [0.1, 0.1, 0.05], sheet: 4 },
];

export const EDGES: [number, number][] = [
  [0, 1], [1, 2], [0, 3], [3, 4], [4, 5], [2, 5], [1, 6], [6, 4], [6, 0], [2, 4],
];

export const NODE_R = 0.075;

export const nodeSegments = (): Segment[][] => NODES.map((n) => octa(n.p, NODE_R));

export const edgeSegments = (): Segment[] => EDGES.map(([i, j]) => ({ a: NODES[i].p, b: NODES[j].p }));

// Pointers: dashed drops from each node to the note it indexes.
export const pointerSegments = (): Segment[][] =>
  NODES.map((n) => {
    const top: Vec3 = [n.p[0], n.p[1] - NODE_R, n.p[2]];
    return dashed(top, sheetCenter(n.sheet), 7, 0.5);
  });
