import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapToolProviderWithReset } from '../dist/host-api.js';

// A fake engine that records resetPending() calls and lets a test drive the
// consent-wait signal the backstop uses to pause its clock.
function fakeEngine() {
  let resets = 0;
  let awaiting = false;
  const listeners = new Set();
  return {
    engine: {
      resetPending() { resets++; },
      isAwaitingConsent() { return awaiting; },
      onConsentWaitChange(l) { listeners.add(l); return () => listeners.delete(l); },
    },
    get resets() { return resets; },
    // Simulate the guest entering/leaving a consent prompt.
    setAwaiting(v) { awaiting = v; for (const l of listeners) l(v); },
  };
}

test('reset fires after an IMMEDIATE call-tool result (guest task done)', async () => {
  const f = fakeEngine();
  const provider = {
    listTools: async () => ({ metadata: [], tools: [] }),
    callTool: async () => ({ tag: 'immediate', val: [] }),
  };
  const wrapped = wrapToolProviderWithReset(provider, f.engine);
  const res = await wrapped.callTool('t', new Uint8Array(), []);
  assert.equal(res.tag, 'immediate');
  assert.equal(f.resets, 1, 'immediate result resets exactly once when callTool resolves');
});

test('reset fires when a call-tool THROWS', async () => {
  const f = fakeEngine();
  const provider = {
    listTools: async () => ({ metadata: [], tools: [] }),
    callTool: async () => { throw { tag: 'internal-error', val: 'boom' }; },
  };
  const wrapped = wrapToolProviderWithReset(provider, f.engine);
  await assert.rejects(() => wrapped.callTool('t', new Uint8Array(), []), (e) => e && e.tag === 'internal-error');
  assert.equal(f.resets, 1, 'an errored call-tool still resets');
});

test('reset for a STREAMING result is DEFERRED to stream end, not callTool resolve', async () => {
  // Safety-critical: the guest keeps running (and may hold a live consent
  // prompt) until the stream ends. Resetting when callTool resolves would clear
  // a legitimately-pending prompt mid-run. Assert the reset waits for the stream.
  const f = fakeEngine();
  const events = [
    { tag: 'content', val: { data: new Uint8Array([1]), mimeType: 'text/plain', metadata: [] } },
    { tag: 'content', val: { data: new Uint8Array([2]), mimeType: 'text/plain', metadata: [] } },
  ];
  const provider = {
    listTools: async () => ({ metadata: [], tools: [] }),
    callTool: async () => ({
      tag: 'streaming',
      val: new ReadableStream({
        start(controller) { for (const e of events) controller.enqueue(e); controller.close(); },
      }),
    }),
  };
  const wrapped = wrapToolProviderWithReset(provider, f.engine);
  const res = await wrapped.callTool('t', new Uint8Array(), []);
  assert.equal(res.tag, 'streaming');
  assert.equal(f.resets, 0, 'must NOT reset merely because callTool resolved (guest still streaming)');

  // Drain the stream; the caller still sees every event, and the reset fires once at the end.
  const reader = res.val.getReader();
  const seen = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen.push(value.tag);
  }
  assert.deepEqual(seen, ['content', 'content'], 'wrapped stream yields all original events');
  assert.equal(f.resets, 1, 'reset fires exactly once when the stream ends');
});

test('a guest that never completes and issues NO consent aborts after the budget with a WIT-safe error + reset', async () => {
  const f = fakeEngine();
  const provider = {
    listTools: async () => ({ metadata: [], tools: [] }),
    callTool: () => new Promise(() => {}), // never resolves; no consent ever raised
  };
  const wrapped = wrapToolProviderWithReset(provider, f.engine, 80); // 80ms active budget
  const t0 = Date.now();
  await assert.rejects(
    () => wrapped.callTool('t', new Uint8Array(), []),
    (e) => {
      assert.equal(e.tag, 'internal-error', 'WIT error-code, never a bare Error');
      assert.match(e.val, /timed out/);
      assert.match(e.val, /reset and try again/);
      return true;
    },
  );
  assert.ok(Date.now() - t0 >= 70, 'must not fire before the budget elapses');
  assert.equal(f.resets, 1, 'resetPending is called on timeout');
});

test('a guest parked on a consent prompt LONGER than the budget does NOT time out (consent-wait excluded)', async () => {
  const f = fakeEngine();
  let resolveCall;
  const provider = {
    listTools: async () => ({ metadata: [], tools: [] }),
    callTool: () => new Promise((r) => { resolveCall = r; }),
  };
  const wrapped = wrapToolProviderWithReset(provider, f.engine, 100); // 100ms active budget
  const p = wrapped.callTool('t', new Uint8Array(), []);
  // Guest immediately parks on a consent prompt — the clock must pause.
  f.setAwaiting(true);
  // Sit in the prompt far longer than the budget; a slow human is legitimate.
  await new Promise((r) => setTimeout(r, 350));
  // User finally answers; the guest resumes and completes normally.
  f.setAwaiting(false);
  resolveCall({ tag: 'immediate', val: [] });
  const res = await p; // must NOT have rejected with a timeout
  assert.equal(res.tag, 'immediate');
  assert.equal(f.resets, 1, 'a normally-completed call still resets once');
});

test('a STREAMING guest that stalls mid-stream aborts the stream after the budget', async () => {
  const f = fakeEngine();
  const provider = {
    listTools: async () => ({ metadata: [], tools: [] }),
    callTool: async () => ({
      tag: 'streaming',
      // Emits one event then stalls forever (never closes, no more events).
      val: new ReadableStream({
        start(controller) {
          controller.enqueue({ tag: 'content', val: { data: new Uint8Array([1]), mimeType: 'text/plain', metadata: [] } });
        },
      }),
    }),
  };
  const wrapped = wrapToolProviderWithReset(provider, f.engine, 80);
  const res = await wrapped.callTool('t', new Uint8Array(), []);
  const reader = res.val.getReader();
  const first = await reader.read();
  assert.equal(first.value.tag, 'content', 'events before the stall are delivered');
  await assert.rejects(() => reader.read(), (e) => {
    assert.equal(e.tag, 'internal-error');
    assert.match(e.val, /timed out/);
    return true;
  });
  assert.equal(f.resets, 1, 'resetPending fires when the stalled stream is aborted');
});

test('reset fires once if a streaming result is CANCELLED early', async () => {
  const f = fakeEngine();
  const provider = {
    listTools: async () => ({ metadata: [], tools: [] }),
    callTool: async () => ({
      tag: 'streaming',
      val: new ReadableStream({
        pull(controller) { controller.enqueue({ tag: 'content', val: { data: new Uint8Array(), metadata: [] } }); },
      }),
    }),
  };
  const wrapped = wrapToolProviderWithReset(provider, f.engine);
  const res = await wrapped.callTool('t', new Uint8Array(), []);
  const reader = res.val.getReader();
  await reader.read();
  await reader.cancel('done');
  assert.equal(f.resets, 1, 'cancelling the stream still triggers exactly one reset');
});
