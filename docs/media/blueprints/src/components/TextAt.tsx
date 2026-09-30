import { project, type Camera, type Vec3 } from "../lib/projection";
import { fonts, palette, sizes, type TextMode } from "../style";

// Small text pinned to a 3D point (axis ticks, tile captions). Not a callout: no leader line.
export const TextAt: React.FC<{
  at: Vec3;
  camera: Camera;
  text: string;
  minDim: number;
  opacity: number;
  textMode: TextMode;
  scale?: number;
  anchor?: "start" | "middle" | "end";
  color?: string;
  strike?: number; // 0→1: a strike-through line drawn across the text
}> = ({ at, camera, text, minDim, opacity, textMode, scale = 0.75, anchor = "middle", color = palette.line, strike }) => {
  if (textMode === "none" || opacity <= 0) return null;
  const technical = textMode === "technical";
  const p = project(at, camera);
  const fontSize = (technical ? sizes.labelTechnical : sizes.labelHandwritten) * minDim * scale;
  const w = text.length * fontSize * (technical ? 0.75 : 0.52);
  const x0 = anchor === "start" ? p.x : anchor === "end" ? p.x - w : p.x - w / 2;
  return (
    <g opacity={opacity}>
      <text
        x={p.x}
        y={p.y}
        fill={color}
        fontFamily={technical ? fonts.technical : fonts.handwritten}
        fontWeight={technical ? 500 : 400}
        fontSize={fontSize}
        letterSpacing={technical ? "0.14em" : undefined}
        textAnchor={anchor}
        dominantBaseline="central"
      >
        {technical ? text.toUpperCase() : text}
      </text>
      {!!strike && strike > 0 && (
        <line x1={x0 - fontSize * 0.1} y1={p.y} x2={x0 - fontSize * 0.1 + (w + fontSize * 0.2) * Math.min(1, strike)} y2={p.y}
          stroke={color} strokeWidth={Math.max(1, minDim * 0.0022)} strokeLinecap="round" />
      )}
    </g>
  );
};
