import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsentGate } from '../dist/policy/consent.js';

const ask = { componentRef: 'r', digest: 'd', capId: 'wasi:http', op: { capId: 'wasi:http', key: 'h:443', action: 'GET', attrs: {} } };

test('gate forwards to the handler and returns its verdict', async () => {
  const gate = new ConsentGate(async () => ({ allow: true, remember: 'always' }));
  const v = await gate.decide(ask);
  assert.deepEqual(v, { allow: true, remember: 'always' });
});

test('gate degrades to deny with no handler', async () => {
  const gate = new ConsentGate(undefined);
  const v = await gate.decide(ask);
  assert.equal(v.allow, false);
});

test('gate degrades to deny when the handler throws', async () => {
  const gate = new ConsentGate(async () => { throw new Error('ui crash'); });
  const v = await gate.decide(ask);
  assert.equal(v.allow, false);
});

test('gate degrades to deny when the handler resolves undefined', async () => {
  const gate = new ConsentGate(async () => undefined);
  const v = await gate.decide(ask);
  assert.equal(v.allow, false);
});

test('gate degrades to deny when the handler resolves a shape without allow', async () => {
  const gate = new ConsentGate(async () => ({}));
  const v = await gate.decide(ask);
  assert.equal(v.allow, false);
});
