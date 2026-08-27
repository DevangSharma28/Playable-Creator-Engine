/**
 * `@ion-engine/runtime` — the public ION API.
 *
 * This module is the *entire* supported surface. `package.json`'s `exports`
 * map publishes this path and nothing else, so a deep import into the
 * package's internals fails at resolution time with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` — not a lint warning, an actual module
 * resolution error, in Node, Vite, and TypeScript alike.
 *
 * If something you need isn't exported here, that's a request to make, not a
 * path to work around: an unexported symbol is unexported because it has no
 * stability guarantee, and reaching past this file means your project breaks
 * on an ION upgrade that was supposed to be safe.
 */

// ── The simple API ─────────────────────────────────────────────────────────
//
// What a game is normally written against. `Game`, `Entity` and `ION` cover
// scene building, input, audio, particles, colliders, camera, UI, timing and
// events without any engine wiring. Everything below this block is the
// advanced surface — still supported, still exported, but not what a game
// needs to reach for first.
export { Game, Entity, ION, SimpleZone } from "./simple";
export type { Vec3Like, ShapeOptions, ZoneOptions } from "./simple";

// ── Lifecycle ──────────────────────────────────────────────────────────────
export { IonEngine } from "../../../src/engine/IonEngine";
export type { IonEngineOptions, GameDevFacade } from "../../../src/engine/IonEngine";
export { IonGame } from "./ion-game";
export type { IonGameOptions, IonProjectData } from "./ion-game";

// ── The one-line facade: timers, tweens, events, registries ────────────────
export { Ion, Easing } from "../../../src/engine/Ion";
export type { IonContext } from "../../../src/engine/Ion";
export type { ScheduledHandle, TweenOptions, SequenceStep } from "../../../src/engine/core/Scheduler";
export type { Listener, EventHandle } from "../../../src/engine/core/EventBus";

// ── Animation ──────────────────────────────────────────────────────────────
export { Animator, LoopAnimator } from "../../../src/engine/core/Animator";
export type { AnimatorOptions, LoopAnimatorOptions } from "../../../src/engine/core/Animator";

// ── Entities ───────────────────────────────────────────────────────────────
/** The minimal advanced-API entity contract. Most games extend the simple `Entity` class above instead. */
export type { Entity as EntityContract } from "../../../src/engine/entities/Entity";

// ── Assets ─────────────────────────────────────────────────────────────────
export { AssetLoader } from "../../../src/engine/AssetLoader";
export type { AssetKind, AssetEntry } from "../../../src/engine/AssetLoader";

// ── Camera, lighting, world ────────────────────────────────────────────────
export { CameraHandler } from "../../../src/engine/core/CameraHandler";
export { SceneEnvironment, loadSceneEnv, serializeSceneEnv, defaultSceneEnv, cloneSceneEnv } from "../../../src/engine/scene";
export type {
  CameraRig, CameraEnvConfig, CameraProjection,
  AmbientLightConfig, AmbientMode, DirectionalLightConfig,
  WorldEnvConfig, BackgroundMode, EnvironmentSource, FogMode,
  ShadowTypeName, ToneMappingName, SceneEnvData,
} from "../../../src/engine/scene";

// ── Input ──────────────────────────────────────────────────────────────────
export { InputManager } from "../../../src/engine/core/InputManager";
export type { Axis, TapInfo, SwipeInfo, DragInfo, InputHandle } from "../../../src/engine/core/InputManager";
export { DynamicJoystick } from "../../../src/engine/core/DynamicJoystick";

// ── UI ─────────────────────────────────────────────────────────────────────
export { UILayout } from "../../../src/engine/ui/UILayout";
export { EMPTY_LAYOUT, IMPLICITLY_INTERACTIVE, BOX_TYPES } from "../../../src/engine/ui/UILayoutTypes";
export type {
  UILayoutData, UIElementData, UIElementType, UIAnimation, UIActionType, UIAction,
  AnchorPreset, MeasureUnit, UIFillType, UIGradient, UIGradientStop,
  UIElementState, UIStateOverride,
} from "../../../src/engine/ui/UILayoutTypes";

// ── Colliders and areas ────────────────────────────────────────────────────
export {
  Collider, BoxCollider, SphereCollider, CylinderCollider,
  ColliderManager, COLLIDERS_GROUP_NAME,
  // Both directions. `loadColliders` shipped without its counterpart, so
  // colliders were the one editor-authored system a project could read but not
  // write through the public API — every other one exports its serializer.
  loadColliders, colliderFromData, colliderToData,
  shapesOverlap, shapeContainsPoint, penetration,
} from "../../../src/engine/collision";
export type {
  ColliderInit, BoxColliderInit, SphereColliderInit, CylinderColliderInit,
  ColliderEventHandler, ColliderEventHandle, ColliderStats, ResolveOptions,
  ColliderData, CollidersFileData, ColliderShape, ColliderTransformData, ShapeWorld,
} from "../../../src/engine/collision";

// ── Particles and VFX ──────────────────────────────────────────────────────
export {
  ParticleManager, ParticleSystem, ParticleEmitter, PARTICLES_GROUP_NAME,
  loadParticles, serializeParticles,
} from "../../../src/engine/particles";
export type {
  ParticleQuality, ParticleSystemConfig, ParticleEmitterConfig,
  ParticlesFileData, ParticleStats, ScalarRange, CurveKey, GradientKey,
  EmitterShapeKind, SimulationSpace, ParticleRenderMode, ParticleBlendMode,
} from "../../../src/engine/particles";

// ── Editor-authored bindings ───────────────────────────────────────────────
export { applyBindings } from "../../../src/engine/Bindings";
export type { BindingsData, FieldBinding } from "../../../src/engine/Bindings";
export { applySceneBindings, sceneObjectPath, resolveSceneObject } from "../../../src/engine/SceneBindings";
export type { SceneBindingsData, SceneFieldBinding } from "../../../src/engine/SceneBindings";

// ── Ad-network integration ─────────────────────────────────────────────────
export { Cta } from "../../../src/engine/Cta";
export type { CtaNetwork } from "../../../src/engine/Cta";
export { MraidAdapter } from "../../../src/engine/MraidAdapter";
export { MindworksAdapter } from "../../../src/engine/MindworksAdapter";
export { setCrashRecoveryUrl } from "../../../src/engine/core/CrashOverlay";

// ── Editor host (used by the dev entry only; inert in production) ───────────
export { registerEditorHost, getEditorHost, isEditorAvailable } from "./editor-host";
export type { EditorHost, EditorSession, EditorOpenOptions, DebugLayer } from "./editor-host";
