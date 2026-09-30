// The house style. Every scene reads from here, so the look stays consistent.

export const palette = {
  background: "#0B2140", // deep blueprint navy
  line: "#D8F1FF", // pale cyan linework
  grid: "#7DB4F0", // faint drafting grid
  accent: "#22E9FF", // electric cyan: orbs, highlights, label dots
  accentCore: "#E8FEFF", // hot center of an orb
};

export const FPS = 24;

export const aspects = {
  "16x9": { width: 1920, height: 1080 },
  "9x16": { width: 1080, height: 1920 },
  "1x1": { width: 1080, height: 1080 },
  // README header banner (3:1). Added for Circadia; every size scales from minDim.
  banner: { width: 2400, height: 800 },
} as const;
export type Aspect = keyof typeof aspects;

export type LineMode = "hand" | "clean";
export type GridMode = "both" | "flat" | "floor" | "none";
export type TextMode = "handwritten" | "technical" | "none";

export type StyleProps = {
  lineMode: LineMode;
  grid: GridMode;
  text: TextMode;
};

export const defaultStyle: StyleProps = {
  lineMode: "hand",
  grid: "both",
  text: "handwritten",
};

// Sizes are fractions of the frame's short side, so every aspect ratio matches.
export const sizes = {
  lineWidth: 0.0021,
  wobble: 0.0028, // hand-drawn wobble amplitude
  overshoot: 0.006, // hand-drawn stroke overshoot past corners
  orb: 0.0042,
  labelHandwritten: 0.034,
  labelTechnical: 0.021,
  flatGridStep: 1 / 24,
};

export const fonts = {
  handwritten: '"Architects Daughter", cursive',
  technical: '"JetBrains Mono", monospace',
};

// Slow and calm: one soft ease in and out.
export const calmEase = [0.45, 0, 0.25, 1] as const;
