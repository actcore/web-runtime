import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setGlobalDispatcher,
  MockAgent,
  fetch as undiciFetch,
} from 'undici';

import {
  Fields,
  Request,
  Response,
  RequestOptions,
  types,
  client,
} from '../dist/shims/wasi-http.js';

// Node's bundled `fetch` is built on Node's internal undici copy, NOT the one
// `npm i undici` installs into node_modules. `setGlobalDispatcher` from the
// user-installed undici thus only intercepts calls routed through the
// user-installed `undici.fetch` — Node's global fetch ignores it.
//
// To make MockAgent intercept the shim's `fetch` calls in Node, swap
// `globalThis.fetch` for undici's fetch during the test. The shim itself
// still calls the global so it stays browser-portable.
globalThis.fetch = undiciFetch;

// Helper: build a Request via the WIT-mapped static factory. The runtime
// constructor is private (gen-types models it as such), so callers must go
// through `Request.new`. The factory locks `headers` + `options` for the
// lifetime of the returned Request — tests that need to mutate fields should
// do it before calling this helper, or work on fresh standalone instances.
function makeRequest({ headers, body, trailers, options } = {}) {
  const h = headers ?? new Fields();
  const t = trailers ?? Promise.resolve({ tag: 'ok', val: undefined });
  const [req] = Request.new(h, body, t, options);
  return req;
}

function makeResponse({ headers, body, trailers } = {}) {
  const h = headers ?? new Fields();
  const t = trailers ?? Promise.resolve({ tag: 'ok', val: undefined });
  const [resp] = Response.new(h, body, t);
  return resp;
}

// Task 7 will rewire response bodies through `Response.consumeBody` lowering
// into the native fetch ReadableStream. For Task 6 the shim buffers the
// response body as a Uint8Array on `resp._bufferedBody`; this helper reads it
// directly. When Task 7 lands, swap this for whatever consume-body returns.
async function readResponseBody(resp) {
  return resp._bufferedBody ?? new Uint8Array();
}

test('Fields: set then get returns values in order', () => {
  const f = new Fields();
  const v1 = new TextEncoder().encode('text/plain');
  const v2 = new TextEncoder().encode('application/cbor');
  f.set('content-type', [v1, v2]);
  const got = f.get('content-type');
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], v1);
  assert.deepEqual(got[1], v2);
});

test('Fields: case-insensitive lookup', () => {
  const f = new Fields();
  f.append('Content-Type', new TextEncoder().encode('text/plain'));
  assert.equal(f.has('content-type'), true);
  assert.equal(f.has('CONTENT-TYPE'), true);
});

test('Fields: forbidden header rejected', () => {
  const f = new Fields();
  assert.throws(
    () => f.append('host', new TextEncoder().encode('evil.com')),
    (e) => e.tag === 'forbidden',
  );
});

test('Fields: getAndDelete returns + clears', () => {
  const f = new Fields();
  f.append('x-trace', new TextEncoder().encode('abc'));
  const out = f.getAndDelete('x-trace');
  assert.equal(out.length, 1);
  assert.equal(f.has('x-trace'), false);
});

test('Fields: copyAll returns deep-copyable entries', () => {
  const f = new Fields();
  f.append('a', new TextEncoder().encode('1'));
  const copy = f.copyAll();
  copy[0][1][0] = 0;
  assert.equal(new TextDecoder().decode(f.get('a')[0]), '1');
});

test('Request defaults: method=GET, no body', () => {
  // Defaults are observable via the getters on a freshly constructed Request.
  // We go through `Request.new` because the runtime constructor is private.
  const r = makeRequest();
  assert.deepEqual(r.getMethod(), { tag: 'get' });
  assert.equal(r.getPathWithQuery(), undefined);
});

test('Request setters round-trip', () => {
  const r = makeRequest();
  r.setMethod({ tag: 'post' });
  r.setPathWithQuery('/api/v1/foo');
  r.setScheme({ tag: 'HTTPS' });
  r.setAuthority('example.com');
  assert.deepEqual(r.getMethod(), { tag: 'post' });
  assert.equal(r.getPathWithQuery(), '/api/v1/foo');
  assert.deepEqual(r.getScheme(), { tag: 'HTTPS' });
  assert.equal(r.getAuthority(), 'example.com');
});

test('Response: default 200, setStatusCode validates range', () => {
  // Response uses a private constructor + static `new` factory, same as
  // Request. Out-of-range status codes throw a plain Error (the WIT method
  // has no typed error variant — see shim source).
  const r = makeResponse();
  assert.equal(r.getStatusCode(), 200);
  r.setStatusCode(404);
  assert.equal(r.getStatusCode(), 404);
  assert.throws(() => r.setStatusCode(99));
  assert.throws(() => r.setStatusCode(1000));
});

test('RequestOptions: clone is independent', () => {
  const o = new RequestOptions();
  o.setConnectTimeout(5_000_000n);
  const c = o.clone();
  c.setConnectTimeout(1_000_000n);
  assert.equal(o.getConnectTimeout(), 5_000_000n);
  assert.equal(c.getConnectTimeout(), 1_000_000n);
});

test('types namespace exports the four resource classes', () => {
  assert.equal(types.Fields, Fields);
  assert.equal(types.Request, Request);
  assert.equal(types.Response, Response);
  assert.equal(types.RequestOptions, RequestOptions);
});

test('client.send: GET maps method/url, returns 200 with body', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const pool = mockAgent.get('https://example.com');
  pool.intercept({ path: '/hello', method: 'GET' })
      .reply(200, 'world', { headers: { 'content-type': 'text/plain' } });

  const r = makeRequest();
  r.setMethod({ tag: 'get' });
  r.setScheme({ tag: 'HTTPS' });
  r.setAuthority('example.com');
  r.setPathWithQuery('/hello');

  const resp = await client.send(r);
  assert.equal(resp.getStatusCode(), 200);
  // Read response body — implementer must choose the right accessor (body field,
  // body() method, ReadableStream, etc.) per the shim's actual shape.
  const body = await readResponseBody(resp);
  assert.equal(new TextDecoder().decode(body), 'world');
  const ct = resp.getHeaders().get('content-type');
  assert.equal(new TextDecoder().decode(ct[0]), 'text/plain');

  await mockAgent.close();
});

test('Response.consumeBody: returns ReadableStream<number> of body bytes', async () => {
  // Task 7 contract: jco's `_trampoline54` calls `Response.consumeBody(rsc,
  // futureResult)` and treats `tuple4_0` as one of {asyncIterable, iterable,
  // ReadableStream}. consumeBody yields the whole body as a single Uint8Array
  // chunk — jco's `appendReadValue` batches array-like values and `drainInto`
  // re-expands them to individual u8s for `_lowerFlatU8` (which writes one byte
  // per value via setUint32). The per-byte enqueue this replaced was ~95 B/s;
  // see ACT-153. This test exercises the path: send → consumeBody → drain
  // reader → assert the flattened bytes equal the served body.
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const pool = mockAgent.get('https://example.com');
  pool.intercept({ path: '/binary', method: 'GET' })
      .reply(200, new Uint8Array([0, 1, 2, 254, 255]), {
        headers: { 'content-type': 'application/octet-stream' },
      });

  const r = makeRequest();
  r.setMethod({ tag: 'get' });
  r.setScheme({ tag: 'HTTPS' });
  r.setAuthority('example.com');
  r.setPathWithQuery('/binary');

  const resp = await client.send(r);
  const okFuture = Promise.resolve({ tag: 'ok', val: undefined });
  const [stream, trailersFuture] = Response.consumeBody(resp, okFuture);

  // Must be a global ReadableStream so jco's `_PlatformReadableStream`
  // instanceof check matches.
  assert.ok(stream instanceof ReadableStream, 'expected ReadableStream');

  const reader = stream.getReader();
  const collected = [];
  // consumeBody yields the whole body as one Uint8Array chunk; jco expands it
  // to individual u8s downstream. Accept either shape (number or array-like)
  // and flatten to bytes before comparing. See ACT-153.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (typeof value === 'number') collected.push(value);
    else for (const b of value) collected.push(b);
  }
  assert.deepEqual(collected, [0, 1, 2, 254, 255]);

  // Trailers future is a real Promise — drain it to make sure it resolves.
  const trailers = await trailersFuture;
  assert.equal(trailers.tag, 'ok');

  await mockAgent.close();
});

test('client.send: network failure maps to error-code variant', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const pool = mockAgent.get('https://unreachable.example');
  pool.intercept({ path: '/' }).replyWithError(new TypeError('fetch failed'));

  const r = makeRequest();
  r.setMethod({ tag: 'get' });
  r.setScheme({ tag: 'HTTPS' });
  r.setAuthority('unreachable.example');
  r.setPathWithQuery('/');

  await assert.rejects(
    () => client.send(r),
    (e) =>
      e.tag === 'internal-error' || e.tag === 'connection-refused' ||
      e.tag === 'destination-not-found',
  );
  await mockAgent.close();
});
