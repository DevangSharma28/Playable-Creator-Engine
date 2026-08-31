/** One recorded event. Property values are restricted to what every analytics backend can actually accept without a serializer. */
export type TelemetryProps = Record<string, string | number | boolean | undefined>;

/** Where events go. Installed by the host page (an ad network's SDK, a QA harness, a console logger); absent by default. */
export type TelemetrySink = (event: string, props: TelemetryProps | undefined, atMs: number) => void;

/**
 * How many events are held while no sink is installed. Small on purpose:
 * this is a hand-off buffer for the SDK-attaches-late case, not a log.
 * Oldest are dropped first.
 */
const BUFFER_LIMIT = 64;

interface BufferedEvent {
  event: string;
  props: TelemetryProps | undefined;
  atMs: number;
}

let sink: TelemetrySink | undefined;
const buffer: BufferedEvent[] = [];

/**
 * The playable's one analytics seam.
 *
 * ## Why the engine owns this
 *
 * Before it, `onCrash` was the only way anything inside a playable could
 * report that something happened, and every network wants more than that —
 * "did they interact", "did they reach the end state", "did they click" are
 * the numbers a campaign is judged on. Without a seam, each playable grows
 * its own `window.someSdk?.track?.(...)` calls scattered through gameplay
 * code, which is exactly the shape `Cta.ts` already exists to prevent for
 * click-through: a per-network branch duplicated at every call site, drifting
 * the moment a network is added.
 *
 * ## Why events are buffered
 *
 * An ad network's SDK frequently attaches *after* the playable's own script
 * has run — the same ordering problem `MraidAdapter.onReady` exists for. An
 * unbuffered seam silently drops every event fired before that, which in
 * practice means the boot and first-interaction events, i.e. the ones worth
 * the most. Events fired before a sink exists are held (up to
 * `BUFFER_LIMIT`) and replayed, in order, the moment one is installed.
 *
 * ## Why it can never throw
 *
 * A sink is host code this engine did not write. A telemetry call that
 * throws mid-frame would take the RAF loop down through `IonEngine`'s crash
 * guard and replace a working playable with the recovery overlay — an
 * analytics bug turning into a total loss of the impression. Every call into
 * a sink is wrapped, and a sink that throws is reported to the console and
 * otherwise ignored.
 *
 * Stateless with respect to the engine's own lifecycle, like `Cta`: usable
 * before `IonEngine.boot()` and after teardown, since it only touches this
 * module's own state.
 */
export const Telemetry = {
  /**
   * Installs the sink and immediately replays anything buffered.
   *
   * Passing `undefined` uninstalls it; events fired after that buffer again,
   * so a host that swaps sinks mid-session loses nothing.
   */
  setSink(next: TelemetrySink | undefined): void {
    sink = next;
    if (!next) return;
    const pending = buffer.splice(0, buffer.length);
    for (const entry of pending) deliver(next, entry.event, entry.props, entry.atMs);
  },

  /** True once a sink is installed — for a dev panel that wants to show whether anything is listening. */
  get hasSink(): boolean {
    return sink !== undefined;
  },

  /** Events held for a sink that hasn't been installed yet. Diagnostic only. */
  get bufferedCount(): number {
    return buffer.length;
  },

  /**
   * Records an event. Never throws, and costs one object allocation when
   * nothing is listening.
   *
   * Event names are the playable's own vocabulary — this doesn't impose a
   * taxonomy, because every network's does differ. `"ion:"`-prefixed names
   * are reserved for events the engine itself emits.
   */
  track(event: string, props?: TelemetryProps): void {
    const atMs = Date.now();
    if (sink) {
      deliver(sink, event, props, atMs);
      return;
    }
    // Oldest-first eviction: the buffer exists so a late-attaching SDK gets
    // the *start* of the session, which is precisely what it cannot
    // reconstruct later — a dropped recent event is one the sink will
    // almost certainly see a successor to.
    if (buffer.length >= BUFFER_LIMIT) buffer.shift();
    buffer.push({ event, props, atMs });
  },

  /** Drops the buffer without delivering it. For tests, and for a host that has decided the session is not to be reported. */
  reset(): void {
    buffer.length = 0;
    sink = undefined;
  },
};

function deliver(target: TelemetrySink, event: string, props: TelemetryProps | undefined, atMs: number): void {
  try {
    target(event, props, atMs);
  } catch (err) {
    console.error(`Telemetry: the installed sink threw on "${event}" (ignored).`, err);
  }
}
