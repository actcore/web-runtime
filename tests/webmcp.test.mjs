import test from 'node:test';
import assert from 'node:assert/strict';

import { isWebmcpAvailable } from '../dist/webmcp.js';

test('isWebmcpAvailable is false when no modelContext exists', () => {
  assert.equal(isWebmcpAvailable(), false);
});

test('isWebmcpAvailable is true when document.modelContext exists', () => {
  globalThis.document = { modelContext: { registerTool: async () => {} } };
  try {
    assert.equal(isWebmcpAvailable(), true);
  } finally {
    delete globalThis.document;
  }
});

test('isWebmcpAvailable falls back to navigator.modelContext', () => {
  const priorNav = globalThis.navigator;
  const priorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { modelContext: { registerTool: async () => {} } },
    writable: true,
    configurable: true
  });
  try {
    assert.equal(isWebmcpAvailable(), true);
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: priorNav,
      writable: priorDesc?.writable ?? true,
      configurable: priorDesc?.configurable ?? true
    });
  }
});

import { encode } from 'cbor2';
import {
  sanitizeName,
  parseInputSchema,
  readReadOnlyHint,
  buildAnnotations,
} from '../dist/webmcp.js';

test('sanitizeName keeps valid chars, replaces others, truncates to 128', () => {
  assert.equal(sanitizeName('get_current_time'), 'get_current_time');
  assert.equal(sanitizeName('weird name/with:sep'), 'weird_name_with_sep');
  assert.equal(sanitizeName(''), 'tool');
  assert.equal(sanitizeName('a'.repeat(200)).length, 128);
});

test('parseInputSchema parses valid JSON Schema, falls back otherwise', () => {
  assert.deepEqual(parseInputSchema('{"type":"object","properties":{"x":{"type":"string"}}}'), {
    type: 'object',
    properties: { x: { type: 'string' } },
  });
  assert.deepEqual(parseInputSchema(''), { type: 'object', properties: {} });
  assert.deepEqual(parseInputSchema('not json'), { type: 'object', properties: {} });
});

test('readReadOnlyHint decodes std:read-only boolean from metadata', () => {
  const meta = [['std:read-only', encode(true, { dcbor: true })]];
  assert.equal(readReadOnlyHint(meta), true);
  assert.equal(readReadOnlyHint([['other', encode(1, { dcbor: true })]]), undefined);
  assert.equal(readReadOnlyHint([]), undefined);
});

test('buildAnnotations sets untrustedContentHint true, readOnlyHint from meta', () => {
  assert.deepEqual(buildAnnotations([['std:read-only', encode(true, { dcbor: true })]]), {
    readOnlyHint: true,
    untrustedContentHint: true,
  });
  assert.deepEqual(buildAnnotations([]), { untrustedContentHint: true });
});
