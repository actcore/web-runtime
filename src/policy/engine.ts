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
    // ask → route to the injected consent handler; remember the verdict.
    const verdict = await this.#d.consent.decide({
      componentRef: this.#d.componentRef,
      digest: this.#d.digest,
      capId: op.capId,
      op,
      description: this.#descriptions[op.capId],
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
