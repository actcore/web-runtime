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

test('ask ConsentAsk carries the declared capability description', async () => {
  const seenAsks = [];
  const dep = {
    componentRef: 'ref', digest: 'dig',
    declaredCapsJson: JSON.stringify({
      'wasi:http': {
        constraints: [{ host: 'api.example.com' }],
        description: 'Fetch pure-Python wheels from PyPI for the install tool. No other network use.',
      },
    }),
    policyJson: JSON.stringify({ default: 'ask' }),
    consent: new ConsentGate(async (ask) => { seenAsks.push(ask); return { allow: true, remember: 'session' }; }),
    cache: new DecisionCache('o|ref|dig', 'none'),
    audit: makeAuditor(() => {}),
  };
  const engine = await buildEngine(dep);
  assert.equal(await engine.decideHttp(op), 'allow');
  assert.equal(seenAsks.length, 1);
  assert.equal(
    seenAsks[0].description,
    'Fetch pure-Python wheels from PyPI for the install tool. No other network use.',
  );
});

test('ask ConsentAsk omits description when the declared value is not a plain string', async () => {
  const seenAsks = [];
  const dep = {
    componentRef: 'ref', digest: 'dig',
    declaredCapsJson: JSON.stringify({
      'wasi:http': {
        constraints: [{ host: 'api.example.com' }],
        description: [['en', 'x']],
      },
    }),
    policyJson: JSON.stringify({ default: 'ask' }),
    consent: new ConsentGate(async (ask) => { seenAsks.push(ask); return { allow: true, remember: 'session' }; }),
    cache: new DecisionCache('o|ref|dig', 'none'),
    audit: makeAuditor(() => {}),
  };
  const engine = await buildEngine(dep);
  assert.equal(await engine.decideHttp(op), 'allow');
  assert.equal(seenAsks.length, 1);
  assert.equal(seenAsks[0].description, undefined);
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

test('concurrent asks for the same op are coalesced into one prompt', async () => {
  // A guest may fire several requests to one host at once (e.g. micropip
  // firing two concurrent wheel fetches). Each hits `ask`; without coalescing
  // each raises its own prompt and a single-slot prompter drops all but the
  // last, leaving the other guest tasks suspended forever. Coalescing routes
  // all concurrent same-op asks through ONE consent prompt.
  let asks = 0;
  let resolveConsent;
  const handler = () => {
    asks++;
    return new Promise((r) => {
      resolveConsent = r;
    });
  };
  const { dep } = deps(JSON.stringify({ default: 'ask' }), handler);
  const engine = await buildEngine(dep);
  const p1 = engine.decideHttp(op);
  const p2 = engine.decideHttp(op);
  await new Promise((r) => setTimeout(r, 10)); // let both reach the ask branch
  assert.equal(asks, 1, 'concurrent same-op asks must share ONE prompt');
  resolveConsent({ allow: true, remember: 'session' });
  assert.equal(await p1, 'allow');
  assert.equal(await p2, 'allow');
});
