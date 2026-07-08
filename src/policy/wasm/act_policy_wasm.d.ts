/* tslint:disable */
/* eslint-disable */

export class PolicyKernel {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Per-class `{ declared, mode }` summary for the audit-at-instantiation log.
     */
    ceilingSummary(): string;
    /**
     * `op_json`: a ResourceOp `{ capId, key, action, attrs }`. Returns
     * `"allow" | "deny" | "ask"`.
     */
    classify(op_json: string): string;
    /**
     * `declared_caps_json`: the decoded `act:component` `std.capabilities` map.
     * `policy_json`: the operator PolicyConfig.
     */
    constructor(declared_caps_json: string, policy_json: string);
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_policykernel_free: (a: number, b: number) => void;
    readonly policykernel_ceilingSummary: (a: number) => [number, number];
    readonly policykernel_classify: (a: number, b: number, c: number) => [number, number, number, number];
    readonly policykernel_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
