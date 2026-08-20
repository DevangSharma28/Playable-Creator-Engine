import * as THREE from "three";

/** Identifies which named sound a SoundHandler call refers to — just background music for now, kept as an enum so a second sound (SFX) has an obvious home instead of a raw string. */
export enum SoundType {
    Music = "MainMusic",
}

/**
 * Thin wrapper around a single looping THREE.Audio for background music.
 * Owns the THREE.AudioListener attached to the gameplay camera — required
 * by three.js's positional/non-positional audio API regardless of whether
 * this sound itself is ever made positional.
 *
 * Browsers refuse to start audio before a real user gesture (a fresh
 * AudioContext boots "suspended" and playing into a suspended context is a
 * silent no-op) — call playMusic() from Game's existing first-input hook
 * (DynamicJoystick's onFirstInput), never eagerly from the constructor.
 */
export class SoundHandler {
    /**
     * Desired output level, 0-1 — live-editable at runtime from the Engine
     * Room's Control Desk (registered under "SoundHandler" in Game.ts's
     * inspectables map) without writing any code: Control Desk already
     * knows how to show/edit any public number field on a registered
     * class, it just needed one to point at. Not applied straight to the
     * THREE.Audio node from a setter — plain field, read once per frame by
     * update() — because Control Desk edits by direct property assignment
     * (`instance.volume = x`), which a get/set accessor pair would also
     * happen to intercept, but accessors don't match the static field-scan
     * regex (script-info in dev-build-api.js) that decides what Control
     * Desk shows in the first place, so they'd silently never appear as an
     * editable field at all. A plain field polled once a frame keeps this
     * whole live-tuning path working without touching that shared scanner.
     */
    volume = 0.6;
    /** Same reasoning as volume above — live on/off from Control Desk. Silences output without stopping playback (position keeps advancing), so unmuting resumes exactly in sync rather than restarting. */
    muted = false;

    private readonly listener: THREE.AudioListener;
    private readonly music: THREE.Audio;
    /** Dev-only: tapped off the music's own output node, lazily — never constructed unless something actually asks for it (see getAnalyser/Game.ts's getAudioAnalyser), so production pays nothing for this. A live AnalyserNode has a real (if small) per-frame cost, and nothing in the shipped playable ever calls getAnalyser(). */
    private analyser: THREE.AudioAnalyser | undefined;

    constructor(camera: THREE.Camera, musicBuffer: AudioBuffer) {
        this.listener = new THREE.AudioListener();
        camera.add(this.listener);

        this.music = new THREE.Audio(this.listener);
        this.music.setBuffer(musicBuffer);
        this.music.setLoop(true);
        this.music.setVolume(this.volume);
    }

    /** Call once per frame (see Game.update()) — applies volume/muted onto the real Web Audio graph. Cheap regardless of whether either actually changed (THREE.Audio.setVolume is just a GainNode.gain.value write), so no dirty-checking. */
    update(): void {
        this.music.setVolume(this.muted ? 0 : this.volume);
    }

    /** Starts the looping background music — safe to call more than once, only the first call (post user-gesture) actually starts it. */
    playMusic(): void {
        if (this.music.isPlaying) return;
        this.music.play();
    }

    /** Dev-only: the Engine Room's Audio Reactor panel polls this for a live frequency-spectrum readout of whatever's actually playing — see IonEngine.ts's __getAudioAnalyser hook. fftSize 128 (64 frequency bins) is plenty of resolution for a small bar-graph visualizer and cheap to compute every frame; raise it if the panel ever wants finer detail. */
    getAnalyser(): THREE.AudioAnalyser {
        if (!this.analyser) this.analyser = new THREE.AudioAnalyser(this.music, 128);
        return this.analyser;
    }

    /** Dev-only: lets the Audio Reactor panel show Playing/Stopped without needing its own analyser just to answer that. */
    get isPlaying(): boolean {
        return this.music.isPlaying;
    }

    dispose(): void {
        if (this.music.isPlaying) this.music.stop();
        this.listener.removeFromParent();
    }
}
