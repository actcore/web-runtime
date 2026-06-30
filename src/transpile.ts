import { applyPatches, rewriteBareImports } from './patches.js';
import type { RunComponentOptions } from './host-api.js';
import type { GenerateOptions } from '@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.js';
import type { TranspileWorkerRequest, TranspileWorkerResponse } from './transpile.worker.js';
import {
  deriveTranspileCacheKey,
  getCachedFiles,
  putCachedFiles,
  type TranspiledFiles,
} from './cache.js';

// The in-browser transpiler. jco 1.24.x moved transpile logic into the
// `@bytecodealliance/jco-transpile` package, whose high-level `transpileBytes`
// statically imports node: builtins (node:child_process / node:os / node:fs)
// and `terser`, so it cannot load under native ESM in a browser. jco's own
// `@bytecodealliance/jco/component` browser entry is also unusable in 1.24.3:
// it imports an `obj/` glue module that the published tarball omits
// (`files: ["lib","src","types"]`). The one browser-safe artifact jco ships is
// the vendored, componentized js-component-bindgen — the same `generate()` jco's
// browser entry called under the hood in earlier releases — which loads its
// core wasm via `fetch` + `import.meta.url` and only touches node:fs when
// `fetch` is absent. We call it directly (see the `import()` below). The
// specifier is exports-map-gated by jco-transpile (no `./vendor/*` export), so
// consumers map it via importmap (see examples/) or a bundler alias; tsc is
// satisfied by src/jco-bindgen.d.ts.
//
// The import below is written as a bare literal (no `@vite-ignore`) on purpose:
// bundlers must be allowed to resolve + bundle it (via the consumer's alias),
// and a no-bundler browser resolves the same literal through its importmap.
// `@vite-ignore` would suppress both, leaving an unresolvable runtime specifier.
//
// `generate()` is synchronous and CPU-heavy: a large component blocks for
// seconds. To keep the page responsive we run it in a Web Worker (see
// ./transpile.worker.ts) and fall back to a main-thread call only when a worker
// can't be created or load. And because its output is a pure function of the
// input bytes + options, we persist it in IndexedDB (see ./cache.ts) so repeat
// loads skip `generate()` altogether.

const DEFAULT_NAME = 'component';

/**
 * Run jco transpile (cached / off-thread), patch the output, and return a blob:
 * URL pointing at the entry ES module. Caller does `await import(url)` to load.
 */
export async function transpileToBlobUrl(
  bytes: Uint8Array,
  options: RunComponentOptions,
): Promise<string> {
  const shimBase = normalizeShimBase(options.shimBase);
  const name = options.name ?? DEFAULT_NAME;
  // Host-view exports wasi:http p3 from our own shim (see wit/host-view.wit
  // and src/shims/wasi-http.ts). preview2-shim's http.js doesn't carry the
  // `client` or p3-shaped `types` exports a wasip3 component imports, so
  // wasi:http resolves to a separate URL than the rest of WASI. Defaults to
  // the bundled shim sibling-to-dist/index.js; callers can override (useful
  // when dist/ is served from a different origin than preview2-shim).
  const wasiHttpShimUrl = options.wasiHttpShimUrl
    ?? new URL('./shims/wasi-http.js', import.meta.url).href;
  // host-browser ships its own wasi:sockets shim: preview2-shim's browser build
  // omits the resource-class constructors any wasi:http-importing component
  // needs present at instantiation. Route wasi:sockets here, not at shimBase.
  const wasiSocketsShimUrl = options.wasiSocketsShimUrl
    ?? new URL('./shims/sockets.js', import.meta.url).href;
  const useCache = options.cache !== false;

  const generateOptions = buildGenerateOptions(name, shimBase, wasiHttpShimUrl, wasiSocketsShimUrl);

  // 1. Cache lookup. The key spans HOST_VERSION + the SHA-256 of `bytes` + the
  //    output-affecting options, so a hit is byte-for-byte the right transpile.
  let cacheKey: string | null = null;
  if (useCache) {
    try {
      cacheKey = await deriveTranspileCacheKey({ bytes, name, shimBase, wasiHttpShimUrl, wasiSocketsShimUrl });
      const cached = await getCachedFiles(cacheKey);
      if (cached) {
        console.debug('[@actcore/host] transpile cache hit — skipping generate()');
        return buildBlobModuleGraph(cached, name, shimBase);
      }
    } catch {
      cacheKey = null; // hashing unavailable — proceed without the cache.
    }
  }

  // 2. Cache miss: transpile (worker, or main thread on fallback).
  const files = await generateFiles(bytes, generateOptions);

  // 3. Populate the cache for next time. Best-effort and non-blocking.
  if (cacheKey) void putCachedFiles(cacheKey, files);

  return buildBlobModuleGraph(files, name, shimBase);
}

/**
 * Build the `generate()` options. The WASI specifier `map` (and thus the emitted
 * import URLs) is a function of `name`/`shimBase`/`wasiHttpShimUrl` — the exact
 * inputs the cache key spans, so a cache hit always matches the live output.
 *
 * We drive the low-level bindgen `generate()` directly so we own the WASI
 * specifier map outright. This deliberately sidesteps jco-transpile's default
 * `wasiShim` map, which (as of jco 1.24) over-populates p3-versioned WASI
 * interfaces onto the Node-only `@bytecodealliance/preview3-shim` — useless in a
 * browser. Our map routes p3 wasi:http at our browser shim and the rest at
 * preview2-shim's browser builds; unversioned `wasi:foo/*` keys match every
 * version the component imports (p2 0.2.x and p3 0.3.0 alike). The `#*`
 * expansion preserves the trailing interface name jco emits per-interface.
 */
function buildGenerateOptions(
  name: string,
  shimBase: string,
  wasiHttpShimUrl: string,
  wasiSocketsShimUrl: string,
): GenerateOptions {
  return {
    name,
    asyncMode: { tag: 'jspi', val: { imports: [], exports: [] } },
    map: [
      ['wasi:cli/*', shimBase + 'cli.js#*'],
      ['wasi:clocks/*', shimBase + 'clocks.js#*'],
      ['wasi:filesystem/*', shimBase + 'filesystem.js#*'],
      ['wasi:http/*', wasiHttpShimUrl + '#*'],
      ['wasi:io/*', shimBase + 'io.js#*'],
      ['wasi:random/*', shimBase + 'random.js#*'],
      ['wasi:sockets/*', wasiSocketsShimUrl + '#*'],
    ],
  };
}

/**
 * Produce the transpile output for `bytes`. Prefers a Web Worker so the
 * multi-second `generate()` call doesn't freeze the page; falls back to a
 * main-thread transpile when a worker can't be created or fails to load (e.g.
 * no-bundler importmap setups, where the worker can't resolve the bindgen).
 */
async function generateFiles(
  bytes: Uint8Array,
  options: GenerateOptions,
): Promise<TranspiledFiles> {
  const viaWorker = await tryGenerateInWorker(bytes, options);
  if (viaWorker) {
    console.debug('[@actcore/host] transpiled in Web Worker (main thread free)');
    return viaWorker;
  }
  console.debug('[@actcore/host] transpiled on main thread (worker unavailable)');
  return generateOnMainThread(bytes, options);
}

/**
 * Resolves to the transpile output, or `null` to signal "worker unavailable —
 * fall back to the main thread". A genuine transpile error from inside the
 * worker is propagated as a rejection (the component is bad; re-running on the
 * main thread would only reproduce it).
 */
function tryGenerateInWorker(
  bytes: Uint8Array,
  options: GenerateOptions,
): Promise<TranspiledFiles | null> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./transpile.worker.js', import.meta.url), {
        type: 'module',
      });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      fn();
    };

    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as TranspileWorkerResponse;
      if (msg && msg.ok) {
        finish(() => resolve(msg.files));
      } else {
        // The worker reached `generate()` but it (or the bindgen) failed. Recover
        // on the main thread, which carries the streaming MIME fallback and is
        // the proven path; if the component is genuinely bad it re-throws there.
        console.debug('[@actcore/host] worker transpile failed, retrying on main thread:', msg?.error);
        finish(() => resolve(null));
      }
    };
    // Fires when the worker module fails to load/resolve (importmap-only setups
    // can't resolve the bindgen specifier in worker scope). Recover on-thread.
    worker.onerror = () => finish(() => resolve(null));

    try {
      // Don't transfer `bytes.buffer`: the main-thread fallback still needs the
      // bytes intact. The clone cost is a memcpy — negligible next to generate().
      worker.postMessage({ bytes, options } satisfies TranspileWorkerRequest);
    } catch (err) {
      finish(() => reject(err as Error));
    }
  });
}

/** Last-resort transpile in the page realm (blocks, but always works). */
async function generateOnMainThread(
  bytes: Uint8Array,
  options: GenerateOptions,
): Promise<TranspiledFiles> {
  // Dynamic import keeps the bindgen (~9MB of wasm) out of the initial bundle
  // for callers that lazy-load.
  const { generate, $init } = await import(
    '@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.js'
  );
  await $init;
  return generate(bytes, options).files;
}

/**
 * Take jco's `files` output and assemble a graph of blob: URLs so the
 * entry module can be `import()`-ed. Each .js file has its bare-import
 * specifiers rewritten to absolute URLs (blob: contexts have no importmap),
 * each .wasm file becomes its own blob, and the entry module gets the
 * runtime patches applied (STREAM_TABLES decl + custom lifts).
 */
function buildBlobModuleGraph(
  files: TranspiledFiles,
  name: string,
  shimBase: string,
): string {
  const decoder = new TextDecoder();
  const fileMap = new Map<string, Uint8Array>(files);

  // 1. Blob-ify all .wasm files first; rewrite refs to those.
  const wasmUrls: Record<string, string> = {};
  for (const [path, bytes] of files) {
    if (path.endsWith('.wasm')) {
      wasmUrls[path] = URL.createObjectURL(
        new Blob([bytes as BlobPart], { type: 'application/wasm' }),
      );
    }
  }

  // 2. Sub-modules in interfaces/. Rewrite bare imports then blob-ify; index
  //    them by their relative path so the entry can refer to them.
  const subUrls: Record<string, string> = {};
  for (const [path, bytes] of files) {
    if (!path.endsWith('.js') || !path.includes('/')) continue;
    const src = rewriteBareImports(decoder.decode(bytes), shimBase);
    subUrls[path] = URL.createObjectURL(
      new Blob([src], { type: 'application/javascript' }),
    );
  }

  // 3. Entry .js — apply runtime patches (future/stream drop guard), bare-import
  //    and relative-import rewrites. Returns a single blob URL.
  const entryFilename = `${name}.js`;
  const entryBytes = fileMap.get(entryFilename);
  if (!entryBytes) {
    throw new Error(`jco transpile output missing entry module ${entryFilename}`);
  }

  let entrySrc = decoder.decode(entryBytes);
  entrySrc = applyPatches(entrySrc);
  entrySrc = rewriteBareImports(entrySrc, shimBase);

  // jco emits `new URL('./X.core.wasm', import.meta.url)` for core wasm refs.
  // When the entry module loads from a blob: URL, that URL constructor resolves
  // to the page origin's root — which 404s. Rewrite the whole expression to
  // the absolute blob URL of our core-wasm blob.
  for (const [path, blobUrl] of Object.entries(wasmUrls)) {
    const pattern = new RegExp(
      String.raw`new\s+URL\s*\(\s*(['"\`])\.\/` +
        path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        String.raw`\1\s*,\s*import\.meta\.url\s*\)`,
      'g',
    );
    entrySrc = entrySrc.replace(pattern, JSON.stringify(blobUrl));
    entrySrc = replaceAllSpec(entrySrc, `./${path}`, blobUrl);
  }
  // Final sanity check.
  const stragglers = entrySrc.match(/['"`][^'"`]*\.core\.wasm['"`]/g);
  if (stragglers) {
    console.warn('[@actcore/host] unmatched .core.wasm references:', stragglers);
  }
  for (const [path, blobUrl] of Object.entries(subUrls)) {
    entrySrc = replaceAllSpec(entrySrc, `./${path}`, blobUrl);
  }

  return URL.createObjectURL(
    new Blob([entrySrc], { type: 'application/javascript' }),
  );
}

function replaceAllSpec(src: string, from: string, to: string): string {
  return src.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`);
}

function normalizeShimBase(base: string): string {
  return base.endsWith('/') ? base : base + '/';
}
