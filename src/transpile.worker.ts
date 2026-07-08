/**
 * Web Worker that runs jco's `generate()` off the main thread.
 *
 * `generate()` is a single, synchronous wasm call that can block for several
 * seconds on large components — long enough to freeze the page if run on the
 * main thread. Hosting it in a worker keeps the UI responsive; the cheap parts
 * (assembling blob: URLs, importing the module) stay on the main thread because
 * blob URLs and module evaluation must happen in the page realm.
 *
 * The worker imports the same vendored, componentized bindgen the main-thread
 * path uses (see ./transpile.ts for why this is the only browser-safe entry).
 * Bundlers (Vite) resolve the specifier and bundle the worker. In no-bundler
 * setups the page importmap does NOT apply to workers, so this import fails to
 * resolve; the main thread detects the worker error and falls back to a
 * main-thread transpile. Nothing here is load-bearing for correctness.
 */

import {
  generate,
  $init,
} from '@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.js';
import type { GenerateOptions } from '@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.js';
import { installCompileStreamingFallback } from './streaming-fallback.js';

// The bindgen's `$init` compiles its ~9 MB core wasm via compileStreaming. In
// dev (Vite) the worker-scope fetch can report a non-`application/wasm` MIME, so
// install the same fallback the page uses — without it, `$init` rejects and the
// whole transpile fails in the worker. Must run before `$init` is awaited.
installCompileStreamingFallback();

/** Main thread → worker. */
export interface TranspileWorkerRequest {
  bytes: Uint8Array;
  options: GenerateOptions;
}

/** Worker → main thread. `timings` splits the worker's wall-clock so the main
 * thread can attribute the total (which also spans worker startup + messaging). */
export type TranspileWorkerResponse =
  | { ok: true; files: Array<[string, Uint8Array]>; timings: { initMs: number; generateMs: number } }
  | { ok: false; error: string };

// `self` in a module worker is the DedicatedWorkerGlobalScope. The project's
// tsconfig loads the DOM lib (for the main-thread code) rather than WebWorker,
// so type the slice we use via a local interface instead of redeclaring `self`.
interface DedicatedWorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: TranspileWorkerResponse, transfer?: Transferable[]): void;
}
const ctx = globalThis as unknown as DedicatedWorkerScope;

ctx.onmessage = (ev: MessageEvent) => {
  void handle(ev.data as TranspileWorkerRequest);
};

async function handle(req: TranspileWorkerRequest): Promise<void> {
  try {
    const t0 = performance.now();
    await $init;
    const t1 = performance.now();
    const result = generate(req.bytes, req.options);
    const t2 = performance.now();
    // Transfer the output buffers back to avoid a second copy of large wasm.
    const transfer = result.files.map(([, b]) => b.buffer);
    ctx.postMessage(
      { ok: true, files: result.files, timings: { initMs: t1 - t0, generateMs: t2 - t1 } },
      transfer as Transferable[],
    );
  } catch (err) {
    ctx.postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
  }
}
