import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from 'cbor2';
import { decodeDeclaredCaps } from '../dist/policy/decode.js';

// Build a minimal wasm module (preamble only) with a custom section named
// "act:component" carrying a CBOR ComponentInfo { std: { capabilities: {...} } }.
function wasmWithCustomSection(name, payload) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const leb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
  const body = [...leb(nameBytes.length), ...nameBytes, ...payload];
  const section = [0x00, ...leb(body.length), ...body]; // id 0 = custom
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // \0asm + version 1
  return new Uint8Array([...header, ...section]);
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
