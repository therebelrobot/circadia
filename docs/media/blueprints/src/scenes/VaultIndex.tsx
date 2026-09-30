import { AbsoluteFill } from "remotion";
import { FlatGrid, FloorGrid } from "../components/Grid";
import { Label } from "../components/Label";
import { GlowDefs, LoopOrbs, makeLoopOrbs } from "../components/LoopOrbs";
import { Strokes, type Stroke3D } from "../components/Strokes";
import { useFontsReady } from "../fonts";
import { swayCamera, useLoop } from "../lib/loop";
import { edgeSegments, NODES, nodeSegments, pointerSegments, SHEETS, vaultSegments } from "../lib/memory";
import { project } from "../lib/projection";
import { withIds } from "../lib/shapes";
import { palette, type StyleProps } from "../style";

// docs/ARCHITECTURE.md §1: the vault holds content, the index holds only pointers,
// and the index can be deleted and rebuilt from the vault at any time.
const T = {
  grid: [0, 1.8],
  vault: [0.3, 2.1],
  nodes: [1.8, 3.2],
  edges: [2.4, 3.8],
  pointers: [3.2, 4.4],
  lblVault: [4.2, 5.2],
  lblIndex: [4.7, 5.7],
  indexGone: [7.0, 7.9], // delete .circadia/index.sqlite…
  lblDelete: [6.6, 7.4],
  lblDeleteOut: [9.2, 9.8],
  indexBack: [8.3, 9.4], // …and `circadia index` rebuilds it
  lblRebuild: [8.6, 9.4],
  out: [10.9, 11.8], // everything retracts so the loop restarts clean
};

const orbs = makeLoopOrbs(12, "vi", { rMin: 1.4, rMax: 2.2, yMin: -0.4, yMax: 1.3 });

export const VaultIndex: React.FC<StyleProps> = ({ lineMode, grid, text }) => {
  useFontsReady();
  const { width, height, minDim, t, L, at, span, cyc } = useLoop();
  const camera = swayCamera(width, height, cyc(1), { yaw: -0.35, yawAmp: 0.22, pitch: -0.34, pitchAmp: 0.03, zoom: 0.8, cy: 0.44 });

  const out = 1 - at(T.out);
  const vaultP = at(T.vault) * out;
  // The index goes away and comes back mid-loop, then leaves with everything else.
  const indexLife = (1 - at(T.indexGone) + at(T.indexBack)) * out;
  const nodesP = Math.min(at(T.nodes), indexLife);
  const edgesP = Math.min(at(T.edges), indexLife);
  const pointersP = Math.min(at(T.pointers), indexLife);

  const vault: Stroke3D[] = vaultSegments().flatMap((s, i) => withIds(s, `sheet${i}`));
  const nodes: Stroke3D[] = nodeSegments().flatMap((s, i) => withIds(s, `node${i}`, { weight: 1.2 }));
  const edges: Stroke3D[] = withIds(edgeSegments(), "edge", { weight: 0.8, opacity: 0.75 });
  const pointers: Stroke3D[] = pointerSegments().flatMap((s, i) => withIds(s, `ptr${i}`, { weight: 0.6, opacity: 0.7 }));

  const showFloor = grid === "floor" || grid === "both";
  const common = { textMode: text, lineMode, minDim, frameWidth: width } as const;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <GlowDefs />
        {(grid === "flat" || grid === "both") && <FlatGrid width={width} height={height} />}
        {showFloor && <FloorGrid camera={camera} minDim={minDim} reveal={at(T.grid) * (1 - at(T.out))} />}
        <Strokes segments={vault} camera={camera} progress={vaultP} mode={lineMode} minDim={minDim} />
        <Strokes segments={pointers} camera={camera} progress={pointersP} mode={lineMode} minDim={minDim} color={palette.accent} />
        <Strokes segments={edges} camera={camera} progress={edgesP} mode={lineMode} minDim={minDim} />
        <Strokes segments={nodes} camera={camera} progress={nodesP} mode={lineMode} minDim={minDim} />
        <LoopOrbs orbs={orbs} camera={camera} t={t} L={L} fade={at([1.5, 3]) * (1 - at(T.out))} minDim={minDim} />
        <Label
          anchor={project([SHEETS[0].x - 0.2, -1.1, SHEETS[0].z + 0.1], camera)}
          text="vault: markdown notes you can read" side={-1} rise={-1} reach={1.4}
          progress={span(T.lblVault, T.out)} seed="lbl-vault" {...common}
        />
        <Label
          anchor={project(NODES[5].p, camera)}
          text="index: pointers only" side={1} rise={1} reach={1.2}
          progress={span(T.lblIndex, T.indexGone)} seed="lbl-index" {...common}
        />
        <Label
          anchor={project(NODES[3].p, camera)}
          text="delete the index…" side={-1} rise={1} reach={1.4}
          progress={span(T.lblDelete, T.lblDeleteOut)} seed="lbl-del" {...common}
        />
        <Label
          anchor={project(NODES[2].p, camera)}
          text="…rebuild it from the vault" side={1} rise={-1} reach={1.4}
          progress={span(T.lblRebuild, T.out)} seed="lbl-rebuild" {...common}
        />
      </svg>
    </AbsoluteFill>
  );
};
