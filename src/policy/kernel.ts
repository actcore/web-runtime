import init, { PolicyKernel } from './wasm/act_policy_wasm.js';
import { WASM_BYTES } from './wasm/inline.js';

export type Decision = 'allow' | 'deny' | 'ask';

export interface KernelHandle {
  /** opJson: a ResourceOp `{ capId, key, action, attrs }`. */
  classify(opJson: string): Decision;
  ceilingSummary(): string;
  /** Frees the underlying wasm `PolicyKernel` instance's linear memory. */
  free(): void;
}

let ready: Promise<void> | undefined;

/**
 * Loads the vendored `act-policy` decision kernel (wasm) and builds per-run
 * ceilings. The SAME wasm bytes load under Node's test runner and in the
 * browser because wasm-bindgen `--target web` `init()` accepts a BufferSource.
 */
export class Kernel {
  static load(): Promise<void> {
    // init() is idempotent-safe to await once; cache the promise.
    ready ??= init({ module_or_path: WASM_BYTES }).then(() => undefined);
    return ready;
  }

  /** Requires `await Kernel.load()` first. */
  static build(declaredCapsJson: string, policyJson: string): KernelHandle {
    const k = new PolicyKernel(declaredCapsJson, policyJson);
    return {
      classify: (opJson: string) => k.classify(opJson) as Decision,
      ceilingSummary: () => k.ceilingSummary(),
      free: () => k.free(),
    };
  }
}
