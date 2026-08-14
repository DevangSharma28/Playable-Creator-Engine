import { IonEngine } from "./engine/IonEngine";

const canvas = document.getElementById("game") as HTMLCanvasElement;
IonEngine.boot(canvas);
