import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode } from 'cbor2';
import { decodeDeclaredCaps } from '../dist/policy/decode.js';

const leb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };

// Build a custom section: id 0 = custom, body = LEB(nameLen) + name + payload.
function customSection(name, payload) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const body = [...leb(nameBytes.length), ...nameBytes, ...payload];
  return [0x00, ...leb(body.length), ...body];
}

// Build a minimal wasm module (preamble only) with a custom section named
// "act:component" carrying a CBOR ComponentInfo { std: { capabilities: {...} } }.
function wasmWithCustomSection(name, payload) {
  const section = customSection(name, payload);
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // \0asm + version 1
  return new Uint8Array([...header, ...section]);
}

// Same as wasmWithCustomSection, but explicit, for reuse as the "core module"
// nested inside a component wrapper below.
function coreModuleWithCustom(name, payload) {
  return wasmWithCustomSection(name, payload);
}

// A generic section = [id, ...leb(len), ...bytes].
function section(id, bytes) {
  return [id, ...leb(bytes.length), ...bytes];
}

// Wrap core module bytes in a component-model preamble (0d 00 01 00), placing
// the core module bytes as the payload of a section (id=1) so the byte-walker
// recurses into it — mirroring how act-build nests act:component inside the
// component's embedded core module.
function componentWrapping(coreModuleBytes) {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]; // \0asm + component version/layer
  const sec = section(1, coreModuleBytes);
  return new Uint8Array([...header, ...sec]);
}

test('decodes declared capabilities from the act:component section', async () => {
  const info = { std: { capabilities: { 'wasi:http': { constraints: [{ host: 'api.example.com' }] } } } };
  const bytes = wasmWithCustomSection('act:component', encode(info, { dcbor: true }));
  const caps = await decodeDeclaredCaps(bytes);
  assert.deepEqual(caps, { 'wasi:http': { constraints: [{ host: 'api.example.com' }] } });
});

test('returns empty map when the section is absent', async () => {
  const bytes = wasmWithCustomSection('other', new Uint8Array([0xa0])); // empty CBOR map, wrong name
  const caps = await decodeDeclaredCaps(bytes);
  assert.deepEqual(caps, {});
});

test('decodes declared capabilities nested inside a component-model binary (C1 regression)', async () => {
  const info = { std: { capabilities: { 'wasi:http': { constraints: [{ host: 'api.example.com' }] } } } };
  const core = coreModuleWithCustom('act:component', encode(info, { dcbor: true }));
  const bytes = componentWrapping(core);
  const caps = await decodeDeclaredCaps(bytes);
  assert.deepEqual(caps, { 'wasi:http': { constraints: [{ host: 'api.example.com' }] } });
});

test('does not throw on a real component-model binary', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../examples/time.wasm', import.meta.url)));
  await assert.doesNotReject(async () => {
    const caps = await decodeDeclaredCaps(bytes);
    assert.equal(typeof caps, 'object');
    assert.notEqual(caps, null);
  });
});
