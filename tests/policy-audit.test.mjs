import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAuditor } from '../dist/policy/audit.js';

test('auditor forwards records to the sink', () => {
  const seen = [];
  const audit = makeAuditor((r) => seen.push(r));
  const rec = { ts: 1, componentRef: 'x', digest: 'd', capId: 'wasi:http', op: { capId: 'wasi:http', key: 'h:443', action: 'GET', attrs: {} }, decision: 'deny', actor: 'policy', transport: 'builtin' };
  audit(rec);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].decision, 'deny');
});

test('a throwing sink never propagates', () => {
  const audit = makeAuditor(() => { throw new Error('sink boom'); });
  assert.doesNotThrow(() => audit({ ts: 1, componentRef: 'x', digest: 'd', capId: 'wasi:http', op: { capId: 'wasi:http', key: 'h', action: '', attrs: null }, decision: 'allow', actor: 'static', transport: 'builtin' }));
});
