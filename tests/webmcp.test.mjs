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
