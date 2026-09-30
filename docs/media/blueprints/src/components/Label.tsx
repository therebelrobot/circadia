import type { Projected } from "../lib/projection";
import { strokePoints, toPath, trimPoints } from "../lib/sketch";
import { fonts, palette, sizes, type LineMode, type TextMode } from "../style";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// A callout: dot on the object, a leader line, then the text.
// side: 1 = text to the right, -1 = to the left. rise: 1 = leader goes up, -1 = down.
// reach stretches the leader to clear nearby lines. Text stays inside a safe margin of the frame.
export const Label: React.FC<{
  anchor: Projected;
  text: string;
  side: 1 | -1;
  rise?: 1 | -1;
  progress: number; // 0→1
  textMode: TextMode;
  lineMode: LineMode;
  minDim: number;
  seed: string;
  frameWidth: number;
  reach?: number;
}> = ({ anchor, text, side, rise = 1, progress, textMode, lineMode, minDim, seed, frameWidth, reach = 1 }) => {
  if (textMode === "none" || progress <= 0) return null;
  const technical = textMode === "technical";
  const fontSize = (technical ? sizes.labelTechnical : sizes.labelHandwritten) * minDim;
  const charW = fontSize * (technical ? 0.75 : 0.52);
  const gap = minDim * 0.014;
  const margin = minDim * 0.04;
  const elbow = { x: anchor.x + side * minDim * 0.07 * reach, y: anchor.y - rise * minDim * 0.06 };
  const end = { x: elbow.x + side * minDim * 0.05, y: elbow.y };
  const overflowFor = (w: number) =>
    side > 0 ? end.x + gap + w - (frameWidth - margin) : margin - (end.x - gap - w);

  // Wrap onto two lines if it would run off the frame, then nudge inward if still needed.
  let lines = [text];
  if (overflowFor(text.length * charW) > 0 && text.includes(" ")) {
    const words = text.split(" ");
    let best = 1;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(" ").length;
      const b = words.slice(i).join(" ").length;
      const bestA = words.slice(0, best).join(" ").length;
      const bestB = words.slice(best).join(" ").length;
      if (Math.max(a, b) < Math.max(bestA, bestB)) best = i;
    }
    lines = [words.slice(0, best).join(" "), words.slice(best).join(" ")];
  }
  const textW = Math.max(...lines.map((l) => l.length)) * charW;
  const overflow = overflowFor(textW);
  if (overflow > 0) {
    elbow.x -= side * overflow;
    end.x -= side * overflow;
  }
  const lineP = clamp01(progress / 0.6);
  const leg1 = trimPoints(strokePoints(anchor, elbow, lineMode, `${seed}-1`, minDim), clamp01(lineP * 2));
  const leg2 = trimPoints(strokePoints(elbow, end, lineMode, `${seed}-2`, minDim), clamp01(lineP * 2 - 1));
  const textP = clamp01((progress - 0.45) / 0.55);
  const lw = sizes.lineWidth * minDim * 0.8;
  const textX = end.x + side * gap - side * (1 - textP) * minDim * 0.01;
  return (
    <g>
      <circle cx={anchor.x} cy={anchor.y} r={minDim * 0.0045 * clamp01(progress * 4)} fill={palette.accent} />
      {technical && (
        <circle cx={anchor.x} cy={anchor.y} r={minDim * 0.011} fill="none" stroke={palette.accent}
          strokeWidth={lw * 0.6} opacity={clamp01(progress * 3) * 0.7} />
      )}
      <g fill="none" stroke={palette.line} strokeWidth={lw} strokeLinecap="round" opacity={0.85}>
        {leg1.length > 1 && <path d={toPath(leg1)} />}
        {leg2.length > 1 && <path d={toPath(leg2)} />}
      </g>
      <text
        x={textX}
        y={end.y}
        fill={palette.line}
        opacity={textP}
        fontFamily={technical ? fonts.technical : fonts.handwritten}
        fontWeight={technical ? 500 : 400}
        fontSize={fontSize}
        letterSpacing={technical ? "0.14em" : undefined}
        textAnchor={side > 0 ? "start" : "end"}
        dominantBaseline="central"
      >
        {lines.map((l, i) => (
          <tspan key={i} x={textX} dy={i === 0 ? `${-(lines.length - 1) * 0.6}em` : "1.2em"}>
            {technical ? l.toUpperCase() : l}
          </tspan>
        ))}
      </text>
    </g>
  );
};
