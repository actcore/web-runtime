import type { AuditSink } from './audit.js';
import type { ConsentGate } from './consent.js';
import type { DecisionCache } from './cache.js';
import type { AuditRecord, ResourceOp } from './types.js';
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

export async function buildEngine(deps: EngineDeps): Promise<PolicyEngine> {
  await Kernel.load();
  const handle = Kernel.build(deps.declaredCapsJson, deps.policyJson);
  await deps.cache.loadPersisted();
  return new PolicyEngine(handle, deps);
}

/** Ties the wasm kernel to consent + cache + audit. Implements HttpPolicyPort. */
export class PolicyEngine {
  #k: KernelHandle;
  #d: EngineDeps;
  constructor(handle: KernelHandle, deps: EngineDeps) {
    this.#k = handle;
    this.#d = deps;
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
    const decision = this.#k.classify(JSON.stringify(op));
    if (decision === 'allow' || decision === 'deny') {
      this.#emit(op, decision, 'policy');
      return decision;
    }
    // ask → route to the injected consent handler; remember the verdict.
    const verdict = await this.#d.consent.decide({
      componentRef: this.#d.componentRef,
      digest: this.#d.digest,
      capId: op.capId,
      op,
    });
    this.#d.cache.put(opKey, verdict);
    const result = verdict.allow ? 'allow' : 'deny';
    this.#emitAsk(op, verdict.allow);
    return result;
  }

  /**
   * Frees the wasm `PolicyKernel` instance backing this engine. Without this
   * call the kernel's linear-memory allocation is never released (a leak per
   * run) — wasm-bindgen resources are not garbage-collected automatically.
   * Call once the governed component is done running (see
   * `ComponentInstance.dispose` in host-api.ts).
   */
  dispose(): void {
    this.#k.free();
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
