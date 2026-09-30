import "@fontsource/architects-daughter/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { useEffect, useState } from "react";
import { continueRender, delayRender } from "remotion";

// Holds rendering until both fonts have loaded, so no frame renders with a fallback font.
export const useFontsReady = () => {
  const [handle] = useState(() => delayRender("Loading fonts"));
  useEffect(() => {
    Promise.all([
      document.fonts.load('32px "Architects Daughter"'),
      document.fonts.load('500 32px "JetBrains Mono"'),
    ]).then(() => continueRender(handle));
  }, [handle]);
};
