import { IonEngine } from "./engine/IonEngine";
import { Game } from "./game/Game";

const canvas = document.getElementById("game") as HTMLCanvasElement;
// The engine is handed the game rather than importing it. That inversion is
// what keeps `engine/` genuinely free of any one playable — including of that
// playable's asset manifest, which anything bundling the engine would
// otherwise pull in and try to fetch.
IonEngine.boot(canvas, { createGame: (c) => Game.create(c) });

// Vite HMR (dev only — inert in the production build, where import.meta.hot
// is always undefined): self-accept so ANY change anywhere in this file's
// module graph — this file itself, Game.ts, mainLayout.json/bindings.json
// (both statically imported, so they're real graph dependencies too) —
// re-executes just this module's top-level code in place, replacing
// Vite's default fallback of a full page reload. IonEngine.boot() above
// already handles tearing down the previous running Game instance cleanly
// on each execution (see its own __disposeGame/__gameInstanceGeneration
// doc comment) — nothing extra needed here for that part, this accept()
// call only decides *that* an in-place reload happens, not how.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    const w = window as unknown as { __wasFreecamActive?: () => boolean; __setFreecamActive?: (on: boolean) => void };
    if (w.__wasFreecamActive?.()) w.__setFreecamActive?.(true);
  });
}
