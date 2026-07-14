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

// A realistic embedder prompter that can only render ONE consent prompt at a
// time (a single UI slot). A second `requestConsent` call while one is pending
// OVERWRITES the slot, orphaning the earlier resolver — it is never answered.
// This mirrors the actcore.dev demo's reference prompter. `verdict` is applied
// to whichever ask currently occupies the slot, shortly after it is shown.
function singleSlotPrompter(verdict) {
  let slot = null; // resolver of the ask currently shown
  let answered = 0;
  const handler = (_ask) =>
    new Promise((resolve) => {
      slot = resolve; // single slot: overwrite orphans the previous occupant
      setTimeout(() => {
        if (slot) {
          const r = slot;
          slot = null;
          answered++;
          r(verdict);
        }
      }, 5);
    });
  return { handler, get answered() { return answered; } };
}

// Custom deps allowing two in-ceiling hosts, for the deny/orphan-then-ask tests.
function twoHostDeps(handler) {
  const seen = [];
  return {
    seen,
    dep: {
      componentRef: 'ref', digest: 'dig',
      declaredCapsJson: JSON.stringify({ 'wasi:http': { constraints: [{ host: 'a.example.com' }, { host: 'b.example.com' }] } }),
      policyJson: JSON.stringify({ default: 'ask' }),
      consent: new ConsentGate(handler),
      cache: new DecisionCache('o|ref|dig', 'none'),
      audit: makeAuditor((r) => seen.push(r)),
    },
  };
}
const opA = { capId: 'wasi:http', key: 'a.example.com:443', action: 'GET', attrs: { scheme: 'https' } };
const opB = { capId: 'wasi:http', key: 'b.example.com:443', action: 'GET', attrs: { scheme: 'https' } };

test('resetPending() releases a wedged #inflight so a later SAME-op ask re-prompts', async () => {
  // Repro of the in-browser ask-after-deny wedge: within ONE python-env
  // session a FAILING install leaves an in-ceiling consent ask unanswered (the
  // guest abandoned the wasi:http request when a sibling host denied and the
  // run unwound). The engine's #inflight coalescing pins that never-resolving
  // `consent.decide` promise, so the NEXT run's same-op ask reuses the dead
  // promise and hangs — the consent handler is never invoked again. Binding
  // `resetPending()` to the exec-call boundary clears the leaked entry.
  let calls = 0;
  const handler = async () => { calls++; if (calls === 1) return new Promise(() => {}); return { allow: true, remember: 'once' }; };
  const { dep } = twoHostDeps(handler);
  const engine = await buildEngine(dep);
  const orphaned = engine.decideHttp(opA); // run 1's ask — handler called, never resolves
  void orphaned;                            // the guest abandoned it; it never settles
  await new Promise((r) => setTimeout(r, 0)); // let it register in #inflight
  engine.resetPending();                    // exec-call boundary: drop leaked state
  const later = engine.decideHttp(opA);     // run 2's ask, same op
  const out = await Promise.race([later, new Promise((r) => setTimeout(() => r('WEDGED'), 1000))]);
  assert.equal(out, 'allow');
  assert.equal(calls, 2, 'after resetPending, the later same-op ask must reach a FRESH consent.decide, not the orphaned one');
});

test('resetPending() releases a poisoned serialization chain so a later DIFFERENT-op ask re-prompts', async () => {
  // Same session wedge, different host: without a reset, the ConsentGate
  // serialization chain (#tail) stays poisoned by the never-answered prompt, so
  // EVERY later ask (any host) queues behind the dead promise and its prompt
  // never fires. resetPending() delegates to ConsentGate.reset() to clear it.
  const calls = [];
  const handler = async (ask) => { calls.push(ask.op.key); if (ask.op.key === opA.key) return new Promise(() => {}); return { allow: true, remember: 'once' }; };
  const { dep } = twoHostDeps(handler);
  const engine = await buildEngine(dep);
  const orphaned = engine.decideHttp(opA); // run 1's ask to host A — never answered
  void orphaned;
  await new Promise((r) => setTimeout(r, 0));
  engine.resetPending();                    // exec-call boundary
  const later = engine.decideHttp(opB);     // run 2's ask to host B
  const out = await Promise.race([later, new Promise((r) => setTimeout(() => r('WEDGED'), 1000))]);
  assert.equal(out, 'allow');
  assert.ok(calls.includes(opB.key), 'after resetPending, a later different-op ask must reach the consent handler');
});

test('WITHOUT resetPending an orphaned ask still wedges a later same-op ask (guards the reset is load-bearing)', async () => {
  // Companion to the two tests above: proves the wedge is real and that
  // `resetPending()` is what clears it — remove the reset and the later ask hangs.
  let calls = 0;
  const handler = async () => { calls++; if (calls === 1) return new Promise(() => {}); return { allow: true, remember: 'once' }; };
  const { dep } = twoHostDeps(handler);
  const engine = await buildEngine(dep);
  const orphaned = engine.decideHttp(opA);
  void orphaned;
  await new Promise((r) => setTimeout(r, 0));
  // NO resetPending() here.
  const later = engine.decideHttp(opA);
  const out = await Promise.race([later, new Promise((r) => setTimeout(() => r('WEDGED'), 300))]);
  assert.equal(out, 'WEDGED', 'without the exec-boundary reset the leaked #inflight entry wedges the next same-op ask');
  assert.equal(calls, 1, 'the coalesced later ask never reaches a fresh consent.decide');
});

test('concurrent asks for DIFFERENT hosts all settle through a single-slot prompter (no hang)', async () => {
  // Regression for the browser-demo hang: `_pip.install(<direct wheel URL>)`
  // makes python-env fire several concurrent wasi:http requests. The
  // out-of-ceiling host (example.com) denies cleanly, but the in-ceiling hosts
  // (pypi.org / files.pythonhosted.org) each hit `ask`. The engine routes
  // DIFFERENT ops to the embedder's consent handler in parallel; a single-slot
  // reference prompter surfaces only one, orphaning the rest — their
  // `await pending` in decideHttp never resolves and the run hangs forever.
  const seen = [];
  const P = singleSlotPrompter({ allow: true, remember: 'session' });
  const dep = {
    componentRef: 'ref', digest: 'dig',
    declaredCapsJson: JSON.stringify({
      'wasi:http': { constraints: [{ host: 'pypi.org' }, { host: 'files.pythonhosted.org' }] },
    }),
    policyJson: JSON.stringify({ default: 'ask' }),
    consent: new ConsentGate(P.handler),
    cache: new DecisionCache('o|ref|dig', 'none'),
    audit: makeAuditor((r) => seen.push(r)),
  };
  const engine = await buildEngine(dep);
  const mk = (host) => ({ capId: 'wasi:http', key: `${host}:443`, action: 'GET', attrs: { scheme: 'https' } });

  // Fire the burst concurrently: one out-of-ceiling deny + two in-ceiling asks.
  const pDeny = engine.decideHttp(mk('example.com'));
  const pAsk1 = engine.decideHttp(mk('pypi.org'));
  const pAsk2 = engine.decideHttp(mk('files.pythonhosted.org'));

  const settled = Promise.all([pDeny, pAsk1, pAsk2]);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('decideHttp hung: a consent ask was never resolved')), 1000),
  );
  const [deny, ask1, ask2] = await Promise.race([settled, timeout]);

  // The out-of-ceiling host denies at the policy layer (audited decision:'deny').
  assert.equal(deny, 'deny');
  assert.ok(seen.some((r) => r.op.key === 'example.com:443' && r.decision === 'deny' && r.actor === 'policy'));
  // Both in-ceiling asks were prompted (one at a time) and allowed.
  assert.equal(ask1, 'allow');
  assert.equal(ask2, 'allow');
  assert.equal(P.answered, 2, 'both different-host asks must be individually answered');
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
