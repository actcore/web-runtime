import type { AuditSink } from './audit.js';
import type { ConsentGate } from './consent.js';
import type { DecisionCache } from './cache.js';
import type { AuditRecord, ResourceOp, Verdict } from './types.js';
import { Kernel, type KernelHandle } from './kernel.js';

export interface EngineDeps {
  componentRef: string;
  digest: string;
  declaredCapsJson: string;
  policyJson: string;
  consent: ConsentGate;
  cache: DecisionCache;
  audit: AuditSink;
}

/** Extracts capId→description (only when the wire value is a plain string). */
function parseDescriptions(declaredCapsJson: string): Record<string, string> {
  const descriptions: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(declaredCapsJson);
    if (parsed && typeof parsed === 'object') {
      for (const [capId, decl] of Object.entries(parsed as Record<string, unknown>)) {
        if (decl && typeof decl === 'object') {
          const description = (decl as { description?: unknown }).description;
          if (typeof description === 'string') descriptions[capId] = description;
        }
      }
    }
  } catch {
    // Defensive: malformed declaredCapsJson must never break instantiation.
  }
  return descriptions;
}

export async function buildEngine(deps: EngineDeps): Promise<PolicyEngine> {
  await Kernel.load();
  const handle = Kernel.build(deps.declaredCapsJson, deps.policyJson);
  await deps.cache.loadPersisted();
  return new PolicyEngine(handle, deps, parseDescriptions(deps.declaredCapsJson));
}

/** Ties the wasm kernel to consent + cache + audit. Implements HttpPolicyPort. */
export class PolicyEngine {
  #k: KernelHandle;
  #d: EngineDeps;
  #descriptions: Record<string, string>;
  #disposed = false;
  /**
   * In-flight consent decisions keyed by opKey. Coalesces concurrent `ask`s for
   * the SAME op onto a single prompt: a guest may fire several requests to one
   * host at once (e.g. micropip firing two concurrent wheel fetches), and
   * without this each would raise its own prompt while a single-slot prompter
   * drops all but the last — leaving the other guest tasks suspended forever.
   */
  #inflight = new Map<string, Promise<Verdict>>();
  /**
   * Number of guest tasks currently suspended on a consent prompt (inside
   * `decideHttp`'s `await`). A consent wait is a LEGITIMATE, unbounded wait —
   * the user may take as long as they like — so the exec-timeout backstop
   * (host-api) pauses its clock while this is > 0. Listeners fire on every
   * 0↔>0 transition.
   */
  #awaitingConsent = 0;
  #consentWaitListeners = new Set<(awaiting: boolean) => void>();
  constructor(handle: KernelHandle, deps: EngineDeps, descriptions: Record<string, string> = {}) {
    this.#k = handle;
    this.#d = deps;
    this.#descriptions = descriptions;
  }

  ceilingSummary(): string {
    return this.#k.ceilingSummary();
  }

  async decideHttp(op: ResourceOp): Promise<'allow' | 'deny'> {
    const opKey = `${op.capId}|${op.key}|${op.action}`;
    const cached = this.#d.cache.get(opKey);
    if (cached) {
      this.#emit(op, cached, 'user', 'remembered');
      return cached;
    }
    let decision: 'allow' | 'deny' | 'ask';
    try {
      decision = this.#k.classify(JSON.stringify(op));
    } catch {
      // Fail closed: a kernel error must not propagate a non-WIT Error through
      // the http shim. Audit and deny.
      this.#emit(op, 'deny', 'policy', 'classify-error');
      return 'deny';
    }
    if (decision === 'allow' || decision === 'deny') {
      this.#emit(op, decision, 'policy');
      return decision;
    }
    // ask → route to the injected consent handler, coalescing concurrent asks
    // for the same op onto ONE prompt (see #inflight). Each request still
    // remembers + audits once the shared verdict resolves.
    let pending = this.#inflight.get(opKey);
    if (!pending) {
      pending = this.#d.consent.decide({
        componentRef: this.#d.componentRef,
        digest: this.#d.digest,
        capId: op.capId,
        op,
        description: this.#descriptions[op.capId],
      });
      this.#inflight.set(opKey, pending);
      // Drop the in-flight entry once resolved so a later, non-cached access
      // re-prompts; remembered decisions are served from the cache above. A
      // NEVER-settling consent (a prompt orphaned when the guest abandoned the
      // request) would otherwise pin the dead promise forever; `resetPending()`,
      // called at each exec-call boundary, drops such leaked entries so they
      // cannot wedge a later run (see `resetPending`).
      void pending.finally(() => this.#inflight.delete(opKey));
    }
    // Mark this as a consent WAIT so the exec-timeout backstop pauses its clock:
    // the user may take arbitrarily long to answer, and that time must not count
    // against the run's active budget.
    this.#enterConsentWait();
    let verdict: Verdict;
    try {
      verdict = await pending;
    } finally {
      this.#exitConsentWait();
    }
    this.#d.cache.put(opKey, verdict);
    this.#emitAsk(op, verdict.allow);
    return verdict.allow ? 'allow' : 'deny';
  }

  /** True while any guest task is suspended on a consent prompt. */
  isAwaitingConsent(): boolean {
    return this.#awaitingConsent > 0;
  }

  /**
   * Subscribe to consent-wait transitions: `awaiting` is `true` when the engine
   * goes from no pending prompt to at least one, `false` when the last pending
   * prompt resolves. The exec-timeout backstop (host-api) uses this to EXCLUDE
   * unbounded consent-wait time from its active budget. Returns an unsubscribe.
   */
  onConsentWaitChange(listener: (awaiting: boolean) => void): () => void {
    this.#consentWaitListeners.add(listener);
    return () => this.#consentWaitListeners.delete(listener);
  }

  #enterConsentWait(): void {
    if (++this.#awaitingConsent === 1) this.#notifyConsentWait(true);
  }
  #exitConsentWait(): void {
    if (--this.#awaitingConsent === 0) this.#notifyConsentWait(false);
  }
  #notifyConsentWait(awaiting: boolean): void {
    for (const l of this.#consentWaitListeners) {
      try {
        l(awaiting);
      } catch {
        /* a listener must never break enforcement */
      }
    }
  }

  /**
   * Drops in-flight consent state so it cannot leak across exec-call
   * boundaries. Clears the `#inflight` coalescing map and resets the
   * `ConsentGate` serialization chain.
   *
   * Why this exists: a consent decision only coalesces/serializes correctly
   * while its guest task is alive. When a run FAILS, a concurrent wasi:http ask
   * can be abandoned mid-flight (a sibling host denied and the run unwound),
   * leaving its `consent.decide` promise pending forever — the guest that was
   * awaiting it is gone, but the host-side promise has no cancellation signal.
   * That dead promise stays pinned in `#inflight` (and poisons the gate's
   * serialization chain), so the NEXT run's ask coalesces/queues onto it and
   * hangs — its consent prompt never fires. Binding this reset to the exec-call
   * lifecycle (see `runComponent` in host-api.ts, which calls it after EVERY
   * call-tool completes or errors) guarantees no such leaked state survives
   * into the next run.
   *
   * Safety: a call-tool only finishes after the guest task is done, so no
   * LEGITIMATELY-pending prompt is open at reset time — a live prompt means the
   * guest is still suspended, which means the call-tool has not finished. The
   * reset therefore only ever clears abandoned/leaked state. It does not touch
   * the wasm kernel or the persisted DecisionCache (remembered verdicts
   * survive), so it is cheap and safe to call between runs.
   */
  resetPending(): void {
    this.#inflight.clear();
    this.#d.consent.reset();
  }

  /**
   * Frees the wasm `PolicyKernel` instance backing this engine. Without this
   * call the kernel's linear-memory allocation is never released (a leak per
   * run) — wasm-bindgen resources are not garbage-collected automatically.
   * Call once the governed component is done running (see
   * `ComponentInstance.dispose` in host-api.ts).
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#k.free();
  }

  /**
   * Audits a `wasi:sockets` denial. Sockets are a hard deny in the browser
   * runtime (no local shim exists) — this does not consult the kernel or
   * consent, it only records the denial so it's visible in the audit trail.
   * Does not touch the wasm kernel, so it's safe to call after `dispose()`.
   */
  noteSocketsDenied(): void {
    this.#d.audit({
      ts: Date.now(), componentRef: this.#d.componentRef, digest: this.#d.digest,
      capId: 'wasi:sockets',
      op: { capId: 'wasi:sockets', key: '', action: '', attrs: null },
      decision: 'deny', actor: 'policy', reason: 'unavailable-in-browser', transport: 'builtin',
    });
  }

  #emit(op: ResourceOp, decision: 'allow' | 'deny', actor: AuditRecord['actor'], reason?: string): void {
    this.#d.audit({
      ts: Date.now(), componentRef: this.#d.componentRef, digest: this.#d.digest,
      capId: op.capId, op, decision, actor, reason, transport: 'builtin',
    });
  }

  #emitAsk(op: ResourceOp, allow: boolean): void {
    this.#d.audit({
      ts: Date.now(), componentRef: this.#d.componentRef, digest: this.#d.digest,
      capId: op.capId, op, decision: allow ? 'ask-allow' : 'ask-deny', actor: 'user', transport: 'builtin',
    });
  }
}
