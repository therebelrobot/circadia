import { Composition } from "remotion";
import { aspects, defaultStyle, FPS, type Aspect, type StyleProps } from "./style";
import { Banner } from "./scenes/Banner";
import { BiTemporal } from "./scenes/BiTemporal";
import { Dream } from "./scenes/Dream";
import { Ladder } from "./scenes/Ladder";
import { Sleep } from "./scenes/Sleep";
import { Recall } from "./scenes/Recall";
import { VaultIndex } from "./scenes/VaultIndex";

// Every scene is a seamless loop: the last frame leads straight back into the first.
// Scenes render at the aspects they are used in (explainers 16:9, the header 3:1),
// and can be registered at any other aspect by adding it to `at`.
const scenes: { id: string; component: React.FC<StyleProps>; seconds: number; at: Aspect[] }[] = [
  { id: "Banner", component: Banner, seconds: 10, at: ["banner"] },
  { id: "VaultIndex", component: VaultIndex, seconds: 12, at: ["16x9"] },
  { id: "Recall", component: Recall, seconds: 12, at: ["16x9"] },
  { id: "BiTemporal", component: BiTemporal, seconds: 14, at: ["16x9"] },
  { id: "Sleep", component: Sleep, seconds: 14, at: ["16x9"] },
  { id: "Ladder", component: Ladder, seconds: 10, at: ["16x9"] },
  { id: "Dream", component: Dream, seconds: 12, at: ["16x9"] },
];

export const RemotionRoot: React.FC = () => (
  <>
    {scenes.flatMap((s) =>
      s.at.map((a) => (
        <Composition
          key={`${s.id}-${a}`}
          id={`${s.id}-${a}`}
          component={s.component}
          durationInFrames={s.seconds * FPS}
          fps={FPS}
          width={aspects[a].width}
          height={aspects[a].height}
          defaultProps={defaultStyle}
        />
      )),
    )}
  </>
);
