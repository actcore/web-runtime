import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEngine, PolicyEngine } from '../dist/policy/engine.js';
import { ConsentGate } from '../dist/policy/consent.js';
import { DecisionCache } from '../dist/policy/cache.js';
import { makeAuditor } from '../dist/policy/audit.js';

const op = { capId: 'wasi:http', key: 'api.example.com:443', action: 'GET', attrs: { scheme: 'https' } };

function deps(policyJson, handler) {
  const seen = [];
  return {
    seen,
    dep: {
      componentRef: 'ref', digest: 'dig',
      declaredCapsJson: JSON.stringify({ 'wasi:http': { constraints: [{ host: 'api.example.com' }] } }),
      policyJson,
      consent: new ConsentGate(handler),
      cache: new DecisionCache('o|ref|dig', 'none'),
      audit: makeAuditor((r) => seen.push(r)),
    },
  };
}

test('allowlist policy → allow, audited', async () => {
  const { seen, dep } = deps(JSON.stringify({ default: 'deny', 'wasi:http': { mode: 'allowlist', allow: [{ host: 'api.example.com' }] } }));
  const engine = await buildEngine(dep);
  assert.equal(await engine.decideHttp(op), 'allow');
  assert.equal(seen.at(-1).decision, 'allow');
});

test('ask policy → consent allow, remembered, second call not re-asked', async () => {
  let asks = 0;
  const { dep } = deps(JSON.stringify({ default: 'ask' }), async () => { asks++; return { allow: true, remember: 'session' }; });
  const engine = await buildEngine(dep);
  assert.equal(await engine.decideHttp(op), 'allow');
  assert.equal(await engine.decideHttp(op), 'allow');
  assert.equal(asks, 1); // cached after first ask
});

test('ask policy with no handler → deny', async () => {
  const { dep } = deps(JSON.stringify({ default: 'ask' }), undefined);
  const engine = await buildEngine(dep);
  assert.equal(await engine.decideHttp(op), 'deny');
});

test('dispose() is idempotent', async () => {
  const { dep } = deps(JSON.stringify({ default: 'deny' }));
  const engine = await buildEngine(dep);
  assert.doesNotThrow(() => {
    engine.dispose();
    engine.dispose();
  });
});

test('decideHttp fails closed when kernel classify() throws', async () => {
  const fakeHandle = {
    classify() {
      throw new Error('boom');
    },
    ceilingSummary: () => '{}',
    free() {},
  };
  const dep = {
    componentRef: 'r',
    digest: 'd',
    declaredCapsJson: '{}',
    policyJson: '{}',
    consent: new ConsentGate(undefined),
    cache: new DecisionCache('s', 'none'),
    audit: makeAuditor(() => {}),
  };
  const engine = new PolicyEngine(fakeHandle, dep);
  await assert.doesNotReject(async () => {
    const result = await engine.decideHttp({
      capId: 'wasi:http',
      key: 'h:443',
      action: 'GET',
      attrs: { scheme: 'https' },
    });
    assert.equal(result, 'deny');
  });
});
