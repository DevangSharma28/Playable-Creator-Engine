/**
 * A DOM + WebGL environment real engine code can boot inside, under `node --test`.
 *
 * The engine's runtime half — IonGame, the renderer, UILayout, InputManager,
 * the camera rig — is not separable from the browser: it constructs a
 * `THREE.WebGLRenderer` in its constructor and reads `window.innerWidth` on
 * the next line. Testing any of it therefore means providing a DOM and a GL
 * context rather than mocking the classes under test, which would only ever
 * assert that the mocks match the mocks.
 *
 * jsdom supplies the DOM. The GL context here is a stub, not an
 * implementation: it answers three.js's capability queries with plausible
 * numbers and accepts every draw call silently. That is enough for three.js
 * to build its state machine, compile-and-cache programs, walk the scene
 * graph, count draw calls and report `renderer.info` — which is exactly the
 * behavior worth testing. It draws no pixels, so anything about how a frame
 * *looks* is out of scope here and belongs in a real browser (see
 * scripts/visual-regression.mjs).
 */

import { JSDOM } from "jsdom";
import * as THREE from "three";

/** The subset of GL enums three.js reads back by value rather than passing straight through. */
const GL_ENUM = {
  VERSION: 0x1f02,
  RENDERER: 0x1f01,
  VENDOR: 0x1f00,
  SHADING_LANGUAGE_VERSION: 0x8b8c,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_SAMPLES: 0x8d57,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  MAX_3D_TEXTURE_SIZE: 0x8073,
  MAX_DRAW_BUFFERS: 0x8824,
  SCISSOR_BOX: 0x0c10,
  VIEWPORT: 0x0ba2,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
};

const LIMITS = new Map([
  [GL_ENUM.MAX_TEXTURE_SIZE, 4096],
  [GL_ENUM.MAX_TEXTURE_IMAGE_UNITS, 16],
  [GL_ENUM.MAX_VERTEX_TEXTURE_IMAGE_UNITS, 16],
  [GL_ENUM.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 32],
  [GL_ENUM.MAX_CUBE_MAP_TEXTURE_SIZE, 4096],
  [GL_ENUM.MAX_VERTEX_ATTRIBS, 16],
  [GL_ENUM.MAX_VERTEX_UNIFORM_VECTORS, 1024],
  [GL_ENUM.MAX_VARYING_VECTORS, 30],
  [GL_ENUM.MAX_FRAGMENT_UNIFORM_VECTORS, 1024],
  [GL_ENUM.MAX_SAMPLES, 4],
  [GL_ENUM.MAX_ARRAY_TEXTURE_LAYERS, 256],
  [GL_ENUM.MAX_3D_TEXTURE_SIZE, 2048],
  [GL_ENUM.MAX_DRAW_BUFFERS, 8],
]);

/**
 * Counters the stub keeps so a test can assert on GPU *bookkeeping* —
 * "did dispose() actually delete the textures it created" is a question the
 * real driver answers and `renderer.info` does not.
 */
export function createGLStub() {
  const counts = { textures: 0, buffers: 0, programs: 0, framebuffers: 0, renderbuffers: 0, vertexArrays: 0 };

  const base = {
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    counts,
    getParameter(name) {
      if (LIMITS.has(name)) return LIMITS.get(name);
      if (name === GL_ENUM.VERSION) return "WebGL 2.0 (ION test stub)";
      if (name === GL_ENUM.RENDERER) return "ION Test Stub";
      if (name === GL_ENUM.VENDOR) return "ION";
      if (name === GL_ENUM.SHADING_LANGUAGE_VERSION) return "WebGL GLSL ES 3.00";
      if (name === GL_ENUM.SCISSOR_BOX || name === GL_ENUM.VIEWPORT) return new Int32Array([0, 0, 800, 600]);
      return 0;
    },
    getExtension: () => null,
    getSupportedExtensions: () => [],
    getContextAttributes: () => ({ alpha: false, depth: true, stencil: false, antialias: true }),
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    getProgramParameter: () => 1,
    getShaderParameter: () => 1,
    getProgramInfoLog: () => "",
    getShaderInfoLog: () => "",
    getActiveUniform: () => ({ name: "u", type: 0x1406, size: 1 }),
    getActiveAttrib: () => ({ name: "a", type: 0x1406, size: 1 }),
    getUniformLocation: () => ({}),
    getAttribLocation: () => 0,
    checkFramebufferStatus: () => GL_ENUM.FRAMEBUFFER_COMPLETE,
    getError: () => 0,
    isContextLost: () => false,

    createTexture: () => (counts.textures++, {}),
    deleteTexture: () => void counts.textures--,
    createBuffer: () => (counts.buffers++, {}),
    deleteBuffer: () => void counts.buffers--,
    createProgram: () => (counts.programs++, {}),
    deleteProgram: () => void counts.programs--,
    createFramebuffer: () => (counts.framebuffers++, {}),
    deleteFramebuffer: () => void counts.framebuffers--,
    createRenderbuffer: () => (counts.renderbuffers++, {}),
    deleteRenderbuffer: () => void counts.renderbuffers--,
    createVertexArray: () => (counts.vertexArrays++, {}),
    deleteVertexArray: () => void counts.vertexArrays--,
    createShader: () => ({}),
  };

  // Anything three.js reaches for that isn't spelled out above: an ALL_CAPS
  // name is an enum (0 is a safe "not this branch" answer for the ones that
  // aren't listed), everything else is a command that returns nothing.
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string" && /^[A-Z][A-Z0-9_]*$/.test(prop)) return GL_ENUM[prop] ?? 0;
      return () => undefined;
    },
    has: () => true,
  });
}


/**
 * A hand-driven replacement for `requestAnimationFrame` + `performance.now`.
 *
 * The engine's frame loop reschedules itself from inside its own callback, so
 * a real (or jsdom-simulated) rAF makes every assertion a race. Owning both
 * the callback queue and the clock the loop reads its `dt` from turns "run one
 * frame" into a function call, which is what makes frame-exact assertions —
 * fixed-timestep step counts, shake decay, trigger enter/exit ordering —
 * possible at all.
 */
function installClock(window) {
  let now = 0;
  let nextId = 1;
  let pending = new Map();

  const raf = (callback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  };
  const cancel = (id) => void pending.delete(id);
  const performanceNow = () => now;

  window.requestAnimationFrame = raf;
  window.cancelAnimationFrame = cancel;
  window.performance.now = performanceNow;

  return {
    get now() { return now; },
    /** Run every callback queued as of this moment, having advanced the clock by `ms`. */
    step(ms = 16.7) {
      now += ms;
      const due = pending;
      pending = new Map();
      for (const callback of due.values()) callback(now);
      return due.size;
    },
    /** How many frames are waiting. Zero after a crash — which is how a dead loop is asserted. */
    get pendingFrames() { return pending.size; },
    steps(count, ms = 16.7) {
      for (let i = 0; i < count; i++) this.step(ms);
    },
    install() {
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = cancel;
      globalThis.performance = window.performance;
    },
  };
}

/**
 * A CanvasRenderingContext2D that records nothing and draws nothing.
 *
 * Only used for procedurally generated textures — the particle system's
 * default sprite is a radial gradient painted at startup. Nothing in the test
 * suite asserts on the pixels, only that the code path completes and yields a
 * texture, so the drawing calls are no-ops and the gradient is a shape with
 * the right methods on it.
 */
function create2dStub() {
  const gradient = { addColorStop() { return gradient; } };
  const stub = {
    canvas: null,
    fillStyle: "#000",
    strokeStyle: "#000",
    globalAlpha: 1,
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    createPattern: () => null,
    getImageData: (_x, _y, width = 1, height = 1) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    measureText: (text) => ({ width: String(text).length * 6 }),
  };
  return new Proxy(stub, {
    get: (target, prop) => (prop in target ? target[prop] : () => undefined),
    set: (target, prop, value) => ((target[prop] = value), true),
  });
}

const PAGE = `<!doctype html><html><body>
  <canvas id="game"></canvas>
  <div id="custom-ui-layer"></div>
  <div id="endcard-layer"></div>
</body></html>`;

/**
 * Installs a browser-shaped global environment and returns the handles a test
 * needs, plus a `restore()` that puts every global back exactly as it was.
 *
 * Restoring rather than leaving the globals in place matters under
 * `node --test`, which runs files in one process: a leaked `window` from one
 * suite silently changes what the next one is testing.
 */
export function installDom({ width = 800, height = 600, html = PAGE } = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: "https://ion.test/" });
  const { window } = dom;

  Object.defineProperty(window, "innerWidth", { value: width, writable: true, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, writable: true, configurable: true });
  window.devicePixelRatio = 1;

  const gl = createGLStub();
  const context2d = create2dStub();
  // Dispatched on the requested type. Returning the GL stub for every request
  // meant `getContext("2d")` handed back an object whose createRadialGradient
  // returned undefined — the particle system's default texture then threw on
  // `.addColorStop` before any test could reach it.
  window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
    return kind === "2d" ? context2d : gl;
  };

  const GLOBALS = [
    "window", "document", "navigator", "location",
    "HTMLElement", "HTMLCanvasElement", "HTMLInputElement", "HTMLImageElement",
    "Element", "Node", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent",
    "PointerEvent", "DragEvent", "DataTransfer", "Image", "getComputedStyle",
    "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio", "performance",
    "ResizeObserver", "MutationObserver",
  ];
  const saved = new Map();
  for (const key of GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === "window" ? window : window[key];
    if (value === undefined) continue;
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }

  // jsdom has no WebAudio. three.js only ever asks for a context and hangs
  // nodes off it, so a graph of inert nodes is a faithful enough stand-in to
  // exercise every path an AudioListener/Audio takes — including whether
  // disconnect() is actually called, which is the point of testing it.
  const audio = installAudioStub(window);
  const clock = installClock(window);

  const handle = {
    dom,
    window,
    clock,
    document: window.document,
    gl,
    audio,
    canvas: window.document.getElementById("game"),
    /** Run one engine frame. Shorthand for `env.clock.step()`. */
    frame(ms) { return clock.step(ms); },
    /** Pretend the window changed size, the way a rotation or a resize does. */
    resize(nextWidth, nextHeight) {
      window.innerWidth = nextWidth;
      window.innerHeight = nextHeight;
      window.dispatchEvent(new window.Event("resize"));
    },
    restore() {
      // The engine parks its teardown hook on `window`; running it here keeps
      // one suite's game from surviving into the next file's globals.
      try { window.__disposeGame?.(); } catch { /* a test may have already disposed */ }
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      dom.window.close();
    },
  };

  clock.install();
  return handle;
}

/** A WebAudio graph that records connect/disconnect instead of making sound. */
function installAudioStub(window) {
  const live = new Set();
  const record = { created: 0, connected: 0, disconnected: 0, started: 0, stopped: 0, live };

  /** A WebAudio AudioParam: a number plus the scheduling methods three.js calls on it. */
  const param = (value = 0) => ({
    value,
    setValueAtTime(next) { this.value = next; return this; },
    setTargetAtTime(next) { this.value = next; return this; },
    setValueCurveAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    cancelScheduledValues() { return this; },
  });

  class StubNode {
    constructor(context, kind) {
      this.context = context;
      this.kind = kind;
      this.gain = param(1);
      this.playbackRate = param(1);
      this.buffer = null;
      this.loop = false;
      this.onended = null;
      record.created++;
      live.add(this);
    }
    connect(target) {
      record.connected++;
      return target;
    }
    disconnect() {
      record.disconnected++;
      live.delete(this);
    }
    start() {
      record.started++;
    }
    stop() {
      record.stopped++;
      // A real BufferSource fires onended asynchronously after stop(); code
      // that cleans up in that callback has to be given the chance to run.
      queueMicrotask(() => this.onended?.());
    }
    setPosition() {}
    setOrientation() {}
  }

  class StubAudioContext {
    constructor() {
      this.state = "suspended";
      this.sampleRate = 44100;
      this.currentTime = 0;
      this.destination = new StubNode(this, "destination");
      this.listener = {
        positionX: param(0), positionY: param(0), positionZ: param(0),
        forwardX: param(0), forwardY: param(0), forwardZ: param(-1),
        upX: param(0), upY: param(1), upZ: param(0),
        setPosition() {}, setOrientation() {},
      };
    }
    createGain() { return new StubNode(this, "gain"); }
    createBufferSource() { return new StubNode(this, "source"); }
    createPanner() { return new StubNode(this, "panner"); }
    createAnalyser() { return Object.assign(new StubNode(this, "analyser"), { fftSize: 2048, frequencyBinCount: 1024, getByteFrequencyData() {} }); }
    createStereoPanner() { return new StubNode(this, "stereo"); }
    createBuffer(channels, length, sampleRate) { return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: () => new Float32Array(length) }; }
    decodeAudioData(_data, ok) { const buffer = this.createBuffer(1, 1024, 44100); ok?.(buffer); return Promise.resolve(buffer); }
    resume() { this.state = "running"; return Promise.resolve(); }
    suspend() { this.state = "suspended"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
  }

  window.AudioContext = StubAudioContext;
  globalThis.AudioContext = StubAudioContext;
  window.webkitAudioContext = StubAudioContext;
  // three.js caches one AudioContext for the module's lifetime. Left alone, the
  // second suite in a file would silently be asserting against the first
  // suite's already-closed graph.
  THREE.AudioContext.setContext(new StubAudioContext());
  return record;
}
