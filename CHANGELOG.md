# Changelog

All notable changes to `@actcore/web-runtime` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.1] — 2026-07-09

### Changed

- Releases now publish from CI on a version tag via npm Trusted Publishing (OIDC) with provenance attestation, scoped to a protected `npm` GitHub environment (`.github/workflows/release.yml`). Adds git-cliff changelog generation (`cliff.toml`).

## [0.1.0] — 2026-07-09

Initial public release — a browser runtime for ACT (Agent Component Tools) components.

### Added

- Load, transpile in-browser (via [jco](https://github.com/bytecodealliance/jco)), and run signed ACT wasm components in a browser tab using the WebAssembly Component Model with JSPI — no server, no Node.
- `act:tools/tool-provider@0.2.0`: list and call tools, with both immediate and streaming (`ReadableStream`) tool results.
- `act:sessions/session-provider@0.2.0`: open and close stateful sessions.
- **WebMCP** (`exposeToWebmcp` / `isWebmcpAvailable`): register a loaded component's tools on the browser's native `document.modelContext` so a WebMCP-capable agent can discover and call them — opt-in, feature-gated, teardown via `AbortSignal`.
- Off-main-thread transpilation (Web Worker) with a persistent IndexedDB cache keyed by runtime version + component hash; repeat loads skip transpilation.
- `wasi:http` (wasip3) and `wasi:sockets` browser shims, so components that make network requests (e.g. http-client) run in the browser.
- BCP-47-aware localized string resolution (`resolveLocalizedString`).
- Built on jco 1.25 / jco-transpile 0.4 / WASI 0.3.0. Requires JSPI (Chrome 137+, Firefox Nightly 152+, Safari TP 243+).
