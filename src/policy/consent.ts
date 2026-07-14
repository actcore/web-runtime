import type { ConsentAsk, Verdict } from './types.js';

export type ConsentHandler = (ask: ConsentAsk) => Promise<Verdict>;

const DENY: Verdict = { allow: false, remember: 'session' };

/**
 * Wraps the embedder's injected `requestConsent` handler. A confirmation is a
 * 1:1 request→response: the returned Promise is the verdict. No handler (or a
 * throwing/rejecting one) ⇒ degrade to deny — never hangs. The guest that is
 * awaiting this is JSPI-suspended meanwhile.
 *
 * Prompts are SERIALIZED: `decide` calls invoke the embedder's handler one at a
 * time, in arrival order. A guest can fire several wasi:http requests to
 * DIFFERENT hosts at once (e.g. micropip resolving a wheel + its deps across
 * pypi.org and files.pythonhosted.org during one `install`). The engine
 * coalesces concurrent asks for the SAME op, but different ops each reach the
 * gate; a reference prompter with a single UI slot can only render one at a
 * time, so calling it concurrently drops all but the last — orphaning the other
 * guest tasks (their `decideHttp` never resolves → the run hangs forever).
 * Chaining every prompt behind the previous one guarantees the handler sees a
 * single outstanding ask, so each ask is eventually presented and answered.
 *
 * A prompt that is NEVER answered (an ask orphaned when the guest abandoned its
 * request — e.g. a sibling host denied and the run unwound) would otherwise
 * poison `#tail`, wedging every future ask behind the dead promise so its prompt
 * never fires. `reset()` — called at each exec-call boundary via
 * `PolicyEngine.resetPending()` — drops the chain so a later run starts fresh.
 */
export class ConsentGate {
  #handler: ConsentHandler | undefined;
  /** Tail of the serialized prompt chain; each `decide` waits behind it. */
  #tail: Promise<unknown> = Promise.resolve();
  constructor(handler: ConsentHandler | undefined) {
    this.#handler = handler;
  }
  decide(ask: ConsentAsk): Promise<Verdict> {
    if (!this.#handler) return Promise.resolve(DENY);
    // Queue this prompt after any in-flight one. `#invoke` never rejects, so a
    // failing/denied prompt can't wedge the chain; settle the tail regardless
    // (its own value is irrelevant — only ordering matters) before the next.
    const verdict = this.#tail.then(() => this.#invoke(ask));
    this.#tail = verdict.then(
      () => undefined,
      () => undefined,
    );
    return verdict;
  }

  /**
   * Resets the serialization chain to a clean, resolved tail. Called between
   * exec runs (via `PolicyEngine.resetPending()`) so a never-answered prompt
   * from a prior run cannot wedge the next run's asks. Safe because a run only
   * finishes once its guest task is done — no legitimately-pending prompt is
   * open at reset time (see `PolicyEngine.resetPending`).
   */
  reset(): void {
    this.#tail = Promise.resolve();
  }
  async #invoke(ask: ConsentAsk): Promise<Verdict> {
    try {
      const v = await this.#handler!(ask);
      return v && typeof v === 'object' && typeof (v as { allow?: unknown }).allow === 'boolean'
        ? (v as Verdict)
        : DENY;
    } catch {
      return DENY;
    }
  }
}
