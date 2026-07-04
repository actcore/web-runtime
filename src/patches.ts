/**
 * Runtime patches applied to a jco-transpiled entry-module source string.
 *
 * History: under jco 1.19 this file carried eight patches working around
 * wasip3-async bugs in jco's emitted code, plus a hand-rolled lift (`lift.ts`)
 * that walked `act:tools` task-return records out of linear memory because jco
 * mis-decoded the flat-fields ABI. The jco 1.20→1.24 upgrade (bindgen
 * 1.17→2.0.3) fixed all of them upstream. Verified by transpiling real
 * components (`time.wasm`, `http-client.wasm`) with jco 1.24.3 and running them
 * under JSPI: the anchors are gone or the declarations now emitted, and the
 * native lift returns correct results (tool descriptions, option/variant
 * shapes, metadata, and error events all decode correctly):
 *
 *   - STREAM_TABLES / FUTURE_TABLES now declared        (jco 1.20, PR #1464)
 *   - `class HostFuture` now emitted                    (jco 1.20+)
 *   - host-imported resource lowers now populated       (no more throw-stubs)
 *   - `rscTableCreateOwn` reshaped, resource origination tracked at runtime
 *   - `StreamWritableEnd.write` count reshaped
 *   - async-import `resultPtr: params[0]` → direct-param lifts (bindgen 2.0)
 *   - `_liftFlatU{8,16,32}` storageLen accounting fixed  (jco 1.23.1)
 *   - flat-fields `act:tools` task-return lift           (bindgen 2.0 — `lift.ts`
 *     deleted; the custom lift now produces *worse* output than jco's native one)
 *
 * What remains is one defensive splice: short-circuiting future/stream drops
 * whose wasm-side end was already transferred. It only matters for components
 * importing wasi:http p3 (futures/streams in request/response bodies), goes
 * through `replaceOrWarn` so a moved anchor warns instead of silently no-opping,
 * and is a no-op for components that don't use host-boundary futures/streams.
 */
export function applyPatches(src: string): string {
  let out = src;

  // PATCH: wit-bindgen Rust's future/stream destructor emits
  // `{future,stream}-drop-{readable,writable}(idx)` even after the end has been
  // transferred (e.g. into a `request.new` trailers param), at which point the
  // wasm-side handle is 0. jco's drop helpers then crash on the missing handle.
  // Short-circuit drops with idx=0 — the host already owns the end (or it never
  // existed), so there is nothing to drop on the wasm side. These helpers are
  // only emitted when the component uses futures/streams over the host
  // boundary, so a miss is expected for plain components (e.g. time.wasm) and
  // not flagged.
  for (const fn of [
    'function futureDropReadable(ctx, futureEndWaitableIdx) {',
    'function futureDropWritable(ctx, futureEndWaitableIdx) {',
    'function streamDropReadable(ctx, streamEndWaitableIdx) {',
    'function streamDropWritable(ctx, streamEndWaitableIdx) {',
  ]) {
    if (out.includes(fn)) {
      out = out.replace(fn, fn + '\n    if (!arguments[1]) return;');
    }
  }

  return out;
}

/**
 * Bare-specifier imports for `@bytecodealliance/preview2-shim/*` are emitted
 * by jco's transpile (matching the `map` option we pass), but ES modules
 * loaded from blob: URLs can't see the document's importmap. Rewrite to
 * absolute URLs in-place.
 */
export function rewriteBareImports(src: string, shimBase: string): string {
  const base = shimBase.endsWith('/') ? shimBase : shimBase + '/';
  const mapping: Record<string, string> = {
    '@bytecodealliance/preview2-shim/cli': base + 'cli.js',
    '@bytecodealliance/preview2-shim/clocks': base + 'clocks.js',
    '@bytecodealliance/preview2-shim/io': base + 'io.js',
    '@bytecodealliance/preview2-shim/filesystem': base + 'filesystem.js',
    '@bytecodealliance/preview2-shim/http': base + 'http.js',
    '@bytecodealliance/preview2-shim/random': base + 'random.js',
    '@bytecodealliance/preview2-shim/sockets': base + 'sockets.js',
  };

  let out = src;
  for (const [spec, url] of Object.entries(mapping)) {
    out = out.replaceAll(`'${spec}'`, `'${url}'`).replaceAll(`"${spec}"`, `"${url}"`);
  }
  return out;
}
