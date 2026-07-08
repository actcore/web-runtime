import type {
  ListToolsResponse,
  ToolResult,
} from './generated/interfaces/act-tools-tool-provider.js';
import type { Cbor, Metadata } from './generated/interfaces/act-core-types.js';

import { transpileToBlobUrl } from './transpile.js';
import { fmtDuration, measurePhase } from './timing.js';
import { installCompileStreamingFallback } from './streaming-fallback.js';

/**
 * Typed mirror of the `act:tools/tool-provider@0.2.0` interface as exposed
 * by jco-transpiled modules. Matches the generated types in
 * `./generated/interfaces/act-tools-tool-provider.js`.
 */
export interface ToolProvider {
  listTools(metadata: Metadata): Promise<ListToolsResponse>;
  callTool(name: string, args: Cbor, metadata: Metadata): Promise<ToolResult>;
}

/**
 * Typed mirror of `act:sessions/session-provider@0.2.0` as exposed by
 * jco-transpiled modules (present only on session-provider components).
 */
export interface SessionProvider {
  getOpenSessionArgsSchema(metadata: Metadata): Promise<string>;
  openSession(args: Metadata, metadata: Metadata): Promise<{ id: string; metadata: Metadata }>;
  closeSession(sessionId: string): void;
}

export interface ComponentInstance {
  /** `act:tools/tool-provider@0.2.0` if the component exports it. */
  toolProvider: ToolProvider;
  /** `act:sessions/session-provider@0.2.0` if the component exports it. */
  sessionProvider?: SessionProvider;
}

export interface RunComponentOptions {
  /** Human-readable component name; used for output filenames during transpile. */
  name?: string;
  /**
   * Absolute base URL for the `@bytecodealliance/preview2-shim` browser-build
   * directory (`dist/browser/` as of preview2-shim 0.19; it was `lib/browser/`
   * before). Required: we drive jco's low-level bindgen `generate()` directly
   * and pass our own WASI specifier map, so callers must point at a concrete
   * shim location (CDN, vendored copy, or bundler-resolved path).
   *
   * Example: `'https://cdn.jsdelivr.net/npm/@bytecodealliance/preview2-shim@0.19.0/dist/browser/'`
   */
  shimBase: string;
  /**
   * Optional absolute URL of `dist/shims/wasi-http.js` from `@actcore/web-runtime`.
   * Defaults to the bundled shim resolved relative to host-api's module URL.
   * Override when `@actcore/web-runtime` is loaded from one origin and you want the
   * wasi:http p3 shim served from another.
   */
  wasiHttpShimUrl?: string;
  /**
   * Optional absolute URL of `dist/shims/sockets.js` from `@actcore/web-runtime`.
   * Defaults to the bundled shim resolved relative to host-api's module URL.
   * host-browser ships its own wasi:sockets shim because preview2-shim's
   * browser build omits the resource-class constructors (ResolveAddressStream,
   * Network, TcpSocket, UdpSocket, …) that any wasi:http-importing component
   * needs present at instantiation. Override when serving shims from another
   * origin (same reason as {@link wasiHttpShimUrl}).
   */
  wasiSocketsShimUrl?: string;
  /**
   * Persist + reuse the jco transpile output in IndexedDB, keyed by
   * `@actcore/web-runtime`'s version and the SHA-256 of the component bytes. Defaults
   * to `true`. Set `false` to always transpile fresh (e.g. when debugging the
   * transpiler). No effect where IndexedDB / `crypto.subtle` is unavailable —
   * the cache silently disables itself there. See {@link clearTranspileCache}.
   */
  cache?: boolean;
}

/**
 * Transpile and instantiate an ACT wasm component in the current page,
 * returning a typed handle to its exported provider interfaces.
 *
 * Requires:
 * - `WebAssembly.promising` (JSPI). Available by default in Chrome 137+,
 *   in Firefox Nightly 152+, and in Safari Tech Preview 243+. Tracking
 *   issue: Interop 2026 focus area #10.
 * - The component must be a `wasip3`-style ACT component packed via
 *   `act-build pack` and exporting `act:tools/tool-provider@0.2.0`.
 */
export async function runComponent(
  bytes: Uint8Array,
  options: RunComponentOptions,
): Promise<ComponentInstance> {
  if (typeof (WebAssembly as unknown as { promising?: unknown }).promising !== 'function') {
    throw new Error(
      '@actcore/web-runtime requires JSPI (WebAssembly.promising). Use Chrome 137+ ' +
        '(stable), Firefox Nightly 152+, or Safari Technology Preview 243+. ' +
        'Per Interop 2026 commitment, stable Firefox/Safari ship JSPI in 2026.',
    );
  }

  installCompileStreamingFallback();

  const { url: entryBlobUrl, revoke: revokeBlobUrls } = await transpileToBlobUrl(bytes, options);

  // Dynamic import from a blob: URL compiles + instantiates the component's core
  // wasm in the page realm — a synchronous, main-thread-blocking step that, for
  // large components, freezes the tab *after* the off-thread transpile above.
  // Measure it separately so that freeze is quantified, not hidden.
  const tInstantiate = performance.now();
  let mod: { toolProvider?: ToolProvider; sessionProvider?: SessionProvider };
  try {
    mod = (await import(/* @vite-ignore */ entryBlobUrl)) as {
      toolProvider?: ToolProvider;
      sessionProvider?: SessionProvider;
    };
  } finally {
    // The module has fetched + compiled its (~100MB) core wasm by now; free the
    // blob URLs so they don't accumulate (leak ~100MB) across runs.
    revokeBlobUrls();
  }
  measurePhase('actcore:instantiate', tInstantiate, { component: options.name ?? 'component' });
  console.debug(
    `[@actcore/web-runtime] instantiated on main thread in ${fmtDuration(performance.now() - tInstantiate)}`,
  );

  if (!mod.toolProvider) {
    throw new Error(
      'Component does not export act:tools/tool-provider@0.2.0',
    );
  }

  // sessionProvider is present only on session-provider components; pass it
  // through so callers can open sessions (stateful components need it).
  return { toolProvider: mod.toolProvider, sessionProvider: mod.sessionProvider };
}

