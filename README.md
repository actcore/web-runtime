# @actcore/web-runtime

> Web runtime for [ACT](https://actcore.dev) — load and run signed wasm agent tools in the browser, and expose them to browser agents via WebMCP.

The whole agent stack, no server:

| | Where it lives |
|---|---|
| LLM | wherever you want — remote API, or local via [WebLLM](https://github.com/mlc-ai/web-llm) |
| **Tools** | **the browser, via this package** |
| User data | the browser (IndexedDB, OPFS) |

ACT components are sandboxed wasm modules signed by their author and distributed via OCI registries. This package loads one in a browser tab using [jco](https://github.com/bytecodealliance/jco)'s in-browser transpiler — no server, no Node, no `npm install` required for the *tool*. The end user opens a page; the tool runs in their tab.

## Status

`0.1.0`. The runtime works end-to-end for `act:tools/tool-provider@0.2.0` (immediate **and** streaming results) and `act:sessions/session-provider@0.2.0`. Loaded tools can be exposed to a browser agent via **WebMCP** (`document.modelContext`). OCI pull and Sigstore verification are scheduled for follow-up versions.

## Browser support

Requires [JSPI (JavaScript Promise Integration)](https://github.com/WebAssembly/js-promise-integration) for WebAssembly:

| Browser | JSPI status (2026) | Source |
|---|---|---|
| Chrome 137+ stable / Edge | **shipped by default** | [Interop 2026 #10](https://webkit.org/blog/17818/announcing-interop-2026/) |
| Firefox Nightly 152+ | 93% WPT pass rate | [wpt.fyi](https://wpt.fyi/results/wasm/jsapi/jspi?label=master&label=experimental&aligned&view=interop&q=label%3Ainterop-2026-jspi-for-wasm) |
| Safari Tech Preview 243+ | 93% WPT pass rate | wpt.fyi |
| Firefox stable / Safari stable | shipping during 2026 per [Interop 2026 pledge](https://webkit.org/blog/17818/announcing-interop-2026/) | — |

All four major browsers committed to JSPI parity in Interop 2026.

## Install

```sh
npm install @actcore/web-runtime @bytecodealliance/jco @bytecodealliance/preview2-shim
```

`jco` (which pulls in `@bytecodealliance/jco-transpile`) and `preview2-shim` are
runtime dependencies; bundle them with your app or load via importmap.

> **jco browser note.** jco's documented browser entry
> (`@bytecodealliance/jco/component`) is broken in the published package — the
> `obj/` glue it imports is gitignored out of the tarball — and
> `@bytecodealliance/jco-transpile`'s `.` export statically imports node:
> builtins, so it can't load under native ESM. This package therefore drives the
> one browser-safe artifact jco ships: the vendored, componentized bindgen at
> `@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.js`
> (the same `generate()` jco's browser entry wraps). That subpath is not in
> jco-transpile's `exports` map, so map it explicitly in your importmap (see
> [`examples/basic.html`](examples/basic.html)) or add a bundler resolve alias.

## Quick start

```ts
import { runComponent } from '@actcore/web-runtime';

const wasm = new Uint8Array(await (await fetch('/time.wasm')).arrayBuffer());

const { toolProvider } = await runComponent(wasm, {
  // Where the @bytecodealliance/preview2-shim browser files live. Use a CDN,
  // your bundler's resolved path, or your dev-server alias. preview2-shim 0.19
  // serves its browser build from dist/browser/ (it was lib/browser/ before).
  shimBase: 'https://esm.sh/@bytecodealliance/preview2-shim@0.19.0/dist/browser/',
});

const { tools } = await toolProvider.listTools([]);
console.log(tools); // [{ name: 'get_current_time', description: ..., parametersSchema: ... }]

const result = await toolProvider.callTool(
  'get_current_time',
  new Uint8Array([0xa0]),  // CBOR {} — empty args
  [],
);

if (result.tag === 'immediate') {
  for (const ev of result.val) {
    if (ev.tag === 'content') {
      console.log(new TextDecoder().decode(ev.val.data));  // → "2026-05-11T15:13:23.464+00:00"
    }
  }
}
```

See [`examples/basic.html`](examples/basic.html) for a runnable demo. From a fresh
clone, `npm run sync-wit` once to fetch the WIT deps (via [`wkg`](https://github.com/bytecodealliance/wasm-pkg-tools); see [`wit/README.md`](wit/README.md)), then `npm run build`. Run the demo with `npm run example` (serves the package root so the importmap's `/node_modules/…` paths resolve) and open `http://localhost:8765/examples/basic.html`.

## Expose tools to a browser agent (WebMCP)

Once a component is loaded, register its tools on the browser's native
[WebMCP](https://webmachinelearning.github.io/webmcp/) surface
(`document.modelContext`) so a WebMCP-capable agent can discover and call them:

```ts
import { runComponent, exposeToWebmcp, isWebmcpAvailable } from '@actcore/web-runtime';

const { toolProvider } = await runComponent(wasm, { shimBase });
const { tools } = await toolProvider.listTools([]);

if (isWebmcpAvailable()) {
  const exposure = await exposeToWebmcp(toolProvider, tools);
  console.log(`${exposure.count} tools exposed on document.modelContext`);

  // …later, when swapping components or tearing down:
  exposure.dispose();  // unregisters every tool (aborts the registration signal)
}
```

`exposeToWebmcp(provider, tools, options?)` is opt-in and headless — no UI, no
side effects until you call it. It maps each ACT tool to a WebMCP descriptor
(the tool's JSON-Schema parameters become `inputSchema`; `std:read-only`
metadata becomes `readOnlyHint`; output is marked `untrustedContentHint`),
bridges each descriptor's `execute` to the component's `callTool` (dcbor-encoded
args, `std:session-id` forwarding via `options.getSessionId`, tool-events
drained to text), and unregisters via an `AbortSignal` when you call `dispose()`.

Native WebMCP ships in Chrome 149 behind an origin trial /
`chrome://flags/#enable-webmcp-testing`. Where it is absent,
`isWebmcpAvailable()` returns `false` and `exposeToWebmcp` no-ops
(`{ count: 0, available: false }`), so this is safe to call unconditionally.

## How it works

`runComponent(bytes, options)`:

1. Calls jco's low-level bindgen `generate()` with `asyncMode: jspi` and an explicit `map` pointing WASI specifiers at `preview2-shim` browser builds (and `wasi:http` p3 at the bundled shim). Driving `generate()` directly — rather than `transpileBytes` — keeps the transpiler node-free and lets us own the WASI map, sidestepping jco's default map that routes p3 WASI onto the Node-only `preview3-shim`. `generate()` is a single synchronous wasm call that blocks for ~250ms on a 1MB component but several **seconds** on a large one (e.g. a 100 MB+ Python component), so it runs in a **Web Worker** — the page stays responsive while a big component transpiles. If a worker can't be created or loaded (e.g. an importmap-only page, where workers can't resolve the bindgen specifier), it transparently falls back to a main-thread transpile.
2. **Caches** the transpile output in IndexedDB, keyed by `@actcore/web-runtime`'s version and the SHA-256 of the component bytes. A second load of the same component skips `generate()` entirely (no worker, no multi-second wait). Bumping the package version invalidates the cache, since a new release may ship a different transpiler. Pass `cache: false` to bypass it; call `clearTranspileCache()` to wipe it. The cache silently disables itself where IndexedDB / `crypto.subtle` is unavailable.
3. Applies a thin patch to the emitted JS:
   - rewrite bare `preview2-shim` specifiers to absolute URLs (blob: contexts can't see the page's importmap),
   - short-circuit future/stream drops whose wasm-side end was already transferred (a wit-bindgen Rust quirk on the wasi:http path).
4. Materialises the patched JS + `.core.wasm` as blob URLs, dynamic-imports the entry module, and returns the exported `toolProvider` (and `sessionProvider`, if the component exports one).

The wasip3-async lift bugs that needed heavy patching under jco 1.19 (STREAM_TABLES/FUTURE_TABLES declarations, `HostFuture`, host-resource lowering, `_liftFlatRecord` task-return, storageLen accounting) are all fixed upstream as of jco 1.24 (bindgen 2.0.3) — jco lifts `list-tools` / `call-tool` results natively. This package is now a thin glue layer.

> **Bundler note (Web Worker).** The transpile worker is created with
> `new Worker(new URL('./transpile.worker.js', import.meta.url), { type: 'module' })`
> and dynamic-imports the bindgen, so it code-splits. Configure your bundler to
> emit workers as ES modules — in Vite that's `worker: { format: 'es' }` (the
> default `iife` rejects code-splitting workers). No config is needed for
> importmap / no-bundler pages: they hit the main-thread fallback.

## Roadmap

- v0.2 — OCI pull and Sigstore (cosign) signature verification, via a shared `act-oci-verify` Rust crate compiled to both native (for `act-cli`) and `wasm32-wasip2` (loaded here, hash-pinned in source).
- v0.x — Web Worker isolation (run *components* off the main thread; transpilation already runs in a worker).

## License

MIT OR Apache-2.0
