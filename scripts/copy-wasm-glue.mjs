// Toolchain-free build step: copies the COMMITTED src/policy/wasm/act_policy_wasm.js
// glue into dist/policy/wasm/. No wasm-pack, no cargo, no Rust toolchain required.
//
// tsc only compiles .ts sources — it never copies plain .js files from src/ to
// dist/. dist/policy/kernel.js imports ./wasm/act_policy_wasm.js at runtime, so
// this step vendors the glue into dist/ after tsc runs. This is what `npm run
// build` uses by default; see scripts/build-policy-wasm.mjs for the manual
// regen path (only needed when the Rust act-policy kernel itself changes).
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '../src/policy/wasm/act_policy_wasm.js');
const outDir = join(here, '../dist/policy/wasm');

mkdirSync(outDir, { recursive: true });
copyFileSync(src, join(outDir, 'act_policy_wasm.js'));
console.log('copied vendored wasm glue to dist/policy/wasm/');
