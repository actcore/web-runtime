import type { ConsentAsk, Verdict } from './types.js';

export type ConsentHandler = (ask: ConsentAsk) => Promise<Verdict>;

const DENY: Verdict = { allow: false, remember: 'session' };

/**
 * Wraps the embedder's injected `requestConsent` handler. A confirmation is a
 * 1:1 request→response: the returned Promise is the verdict. No handler (or a
 * throwing/rejecting one) ⇒ degrade to deny — never hangs. The guest that is
 * awaiting this is JSPI-suspended meanwhile.
 */
export class ConsentGate {
  #handler: ConsentHandler | undefined;
  constructor(handler: ConsentHandler | undefined) {
    this.#handler = handler;
  }
  async decide(ask: ConsentAsk): Promise<Verdict> {
    if (!this.#handler) return DENY;
    try {
      const v = await this.#handler(ask);
      return v && typeof v === 'object' && typeof (v as { allow?: unknown }).allow === 'boolean'
        ? (v as Verdict)
        : DENY;
    } catch {
      return DENY;
    }
  }
}
