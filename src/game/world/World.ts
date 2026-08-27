import * as THREE from "three";

/**
 * The static play environment's *gameplay* extents.
 *
 * > **Known Limitation.** `bound` is a single half-extent measured from the
 * > world origin, and Cinema_World.glb's floor is not centred there — it spans
 * > roughly x ∈ [-5.2, 12.1], z ∈ [-12.8, 3.8]. With the default 10, CoinField
 * > can scatter coins onto parts of the ±10 box that have no floor under them.
 * >
 * > The model already answers this properly: it carries a `walkablearea` node
 * > holding four polygons describing exactly where the player may walk. Using
 * > it would mean replacing this scalar with a real area test, which changes
 * > where coins appear — a design decision for the game, not a bug fix, so it
 * > has not been made here. `Player`'s own clamp against `bound` is commented
 * > out, so today only `CoinField` reads this.
 *
 * Lighting, fog, background, tone mapping, and shadow settings used to be
 * built here by hand. They now live in src/game/environment.json and are
 * applied by the engine's SceneEnvironment, so the 3D editor's Environment
 * dock can author them live — the values it ships with are exactly the ones
 * this class used to hardcode, so nothing looks different by default.
 *
 * What's left is the one thing that genuinely belongs to the *game* rather
 * than to the renderer: how far from the origin gameplay is allowed to
 * reach. Nothing in here moves or has per-frame update logic.
 */
export class World {
  /** Half-extent minus a small margin — the furthest an entity should travel from center. */
  readonly bound: number;

  /**
   * @param size Half-extent of the play area, in world units.
   *
   * The procedural ground and walls this class used to build are gone: the
   * environment is a GLB now, and both call sites had been commented out for
   * long enough that the methods were unreachable private code.
   */
  constructor(_scene: THREE.Scene, size = 10) {
    this.bound = size;
  }
}
