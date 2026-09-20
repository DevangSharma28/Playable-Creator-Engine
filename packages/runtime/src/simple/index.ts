export { Game } from "./game";
export { Entity } from "./entity";
// The two handles and the vocabulary they share. `Prop` is what every
// `ION.scene.*` call returns; `SceneNode` is the half it has in common with
// `Entity`, exported so a helper can take "anything in the world".
export { Prop } from "./prop";
export { SceneNode } from "./node";
export type { Vec3Like, Vec3, Quat } from "./node";
export { ION, SimpleZone } from "./ion";
export type { ShapeOptions, ZoneOptions } from "./ion";
