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

import { decode as decodeCbor } from 'cbor2';
import { buildExecute } from '../dist/webmcp.js';

const td = new TextDecoder();
const te = new TextEncoder();

function toolDef(name) {
  return { name, description: { tag: 'plain', val: `desc ${name}` }, parametersSchema: '{"type":"object"}', metadata: [] };
}

function immediateText(text) {
  return { tag: 'immediate', val: [{ tag: 'content', val: { data: te.encode(text), mimeType: 'text/plain', metadata: [] } }] };
}

test('buildExecute returns MCP text content for an immediate result', async () => {
  const provider = { async listTools() { return { metadata: [], tools: [] }; }, async callTool() { return immediateText('12:00'); } };
  const execute = buildExecute(provider, toolDef('t'), {});
  const result = await execute({});
  assert.deepEqual(result, { content: [{ type: 'text', text: '12:00' }] });
});

test('buildExecute marks isError for an error event', async () => {
  const errResult = { tag: 'immediate', val: [{ tag: 'error', val: { kind: 'boom', message: { tag: 'plain', val: 'bad' }, metadata: [] } }] };
  const provider = { async listTools() { return { metadata: [], tools: [] }; }, async callTool() { return errResult; } };
  const result = await buildExecute(provider, toolDef('t'), {})({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom · bad/);
});

test('buildExecute drains a streaming ReadableStream result', async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue({ tag: 'content', val: { data: te.encode('chunk'), mimeType: 'text/plain', metadata: [] } });
      c.close();
    },
  });
  const provider = { async listTools() { return { metadata: [], tools: [] }; }, async callTool() { return { tag: 'streaming', val: stream }; } };
  const result = await buildExecute(provider, toolDef('t'), {})({});
  assert.equal(result.content[0].text, 'chunk');
});

test('buildExecute forwards std:session-id metadata and dcbor args', async () => {
  let captured;
  const provider = {
    async listTools() { return { metadata: [], tools: [] }; },
    async callTool(name, args, metadata) { captured = { name, args, metadata }; return immediateText('ok'); },
  };
  await buildExecute(provider, toolDef('do'), { getSessionId: () => 'sess-1' })({ a: 1 });
  assert.equal(captured.name, 'do');
  assert.deepEqual(decodeCbor(captured.args), { a: 1 });
  assert.equal(captured.metadata[0][0], 'std:session-id');
  assert.equal(decodeCbor(captured.metadata[0][1]), 'sess-1');
});

test('buildExecute catches a thrown provider error', async () => {
  const provider = { async listTools() { return { metadata: [], tools: [] }; }, async callTool() { throw new Error('kaboom'); } };
  const result = await buildExecute(provider, toolDef('t'), {})({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /kaboom/);
});

import { toDescriptor, exposeToWebmcp } from '../dist/webmcp.js';

const fakeProvider = { async listTools() { return { metadata: [], tools: [] }; }, async callTool() { return immediateText('x'); } };

test('toDescriptor maps every field', () => {
  const def = { name: 'get time', description: { tag: 'plain', val: 'gets time' }, parametersSchema: '{"type":"object"}', metadata: [] };
  const d = toDescriptor(fakeProvider, def, {});
  assert.equal(d.name, 'get_time');
  assert.equal(d.description, 'gets time');
  assert.deepEqual(d.inputSchema, { type: 'object' });
  assert.deepEqual(d.annotations, { untrustedContentHint: true });
  assert.equal(typeof d.execute, 'function');
});

test('exposeToWebmcp registers all tools and reports count', async () => {
  const registered = [];
  globalThis.document = { modelContext: { async registerTool(t, o) { registered.push({ t, o }); } } };
  try {
    const exposure = await exposeToWebmcp(fakeProvider, [toolDef('a'), toolDef('b')]);
    assert.equal(exposure.available, true);
    assert.equal(exposure.count, 2);
    assert.equal(registered.length, 2);
    assert.equal(registered[0].t.name, 'a');
    assert.ok(registered[0].o.signal instanceof AbortSignal);
  } finally {
    delete globalThis.document;
  }
});

test('exposeToWebmcp dispose aborts the registration signal', async () => {
  let signal;
  globalThis.document = { modelContext: { async registerTool(_t, o) { signal = o.signal; } } };
  try {
    const exposure = await exposeToWebmcp(fakeProvider, [toolDef('a')]);
    assert.equal(signal.aborted, false);
    exposure.dispose();
    assert.equal(signal.aborted, true);
  } finally {
    delete globalThis.document;
  }
});

test('exposeToWebmcp reports unavailable when no modelContext', async () => {
  const exposure = await exposeToWebmcp(fakeProvider, [toolDef('a')]);
  assert.equal(exposure.available, false);
  assert.equal(exposure.count, 0);
});

test('exposeToWebmcp skips a failing registerTool but counts the rest', async () => {
  globalThis.document = { modelContext: { async registerTool(t) { if (t.name === 'bad') throw new Error('dup'); } } };
  try {
    const exposure = await exposeToWebmcp(fakeProvider, [toolDef('ok'), toolDef('bad'), toolDef('ok2')]);
    assert.equal(exposure.count, 2);
  } finally {
    delete globalThis.document;
  }
});
