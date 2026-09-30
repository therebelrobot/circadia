import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { makeCamera, type Camera } from "./projection";
import { calmEase } from "../style";

// Loop helpers. Every GIF must end exactly where it began, so anything periodic
// (camera sway, orbs, pulses) is written as a whole number of cycles over the loop
// length, and anything one-shot (draw-on, labels) returns to 0 before the last frame.

const ease = Easing.bezier(...calmEase);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const useLoop = () => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const L = durationInFrames / fps; // loop length in seconds
  const t = frame / fps;
  const minDim = Math.min(width, height);
  const at = (range: readonly number[], out: [number, number] = [0, 1], easing = ease) =>
    interpolate(frame, range.map((s) => s * fps), out, { easing, ...clamp });
  // In, hold, out: rises over `inR`, falls over `outR`. 0 at both ends of the loop.
  const span = (inR: readonly number[], outR: readonly number[]) => at(inR) * (1 - at(outR));
  // Phase of a periodic motion with `k` whole cycles per loop.
  const cyc = (k = 1) => (Math.PI * 2 * k * t) / L;
  return { frame, fps, width, height, minDim, L, t, at, span, cyc };
};

// A slow sway instead of a one-way camera move, so the last frame meets the first.
export const swayCamera = (
  width: number,
  height: number,
  phase: number, // cyc(1)
  o: { yaw: number; yawAmp: number; pitch: number; pitchAmp?: number; zoom?: number; cx?: number; cy?: number },
): Camera => {
  const c = makeCamera(
    width,
    height,
    o.yaw + o.yawAmp * Math.sin(phase),
    o.pitch + (o.pitchAmp ?? 0) * Math.sin(phase + Math.PI / 2),
    o.zoom ?? 1,
  );
  if (o.cx !== undefined) c.cx = width * o.cx;
  if (o.cy !== undefined) c.cy = height * o.cy;
  return c;
};

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
