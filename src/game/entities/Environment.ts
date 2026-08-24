import { Scene } from "three";
import sceneBindingsRaw from "../sceneBindings.json";
import { BoxCollider, CylinderCollider } from "../../engine/collision";
import { applySceneBindings, SceneBindingsData } from "../../engine/SceneBindings";
import { ParticleSystemConfig } from "../../engine/particles";

export class Environment{

      public collider: BoxCollider | CylinderCollider | undefined;

      public ambientParticles: ParticleSystemConfig | undefined;
    
    constructor(scene: Scene)
    {
    applySceneBindings(this, "Environment", sceneBindingsRaw as SceneBindingsData, scene);

    }
}