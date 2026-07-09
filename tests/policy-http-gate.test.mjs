import test from 'node:test';
import assert from 'node:assert/strict';
import { setGlobalDispatcher, MockAgent, fetch as undiciFetch } from 'undici';
import {
  Fields,
  Request,
  RequestOptions,
  client,
  __setActivePolicy,
} from '../dist/shims/wasi-http.js';

// Node's bundled `fetch` is built on Node's internal undici copy, NOT the one
// `npm i undici` installs into node_modules — see tests/wasi-http.test.mjs for
// the full explanation. Swap globalThis.fetch so MockAgent can intercept.
globalThis.fetch = undiciFetch;

// Adapted from the task brief's sketch: the brief assumed a 6-arg static
// `Request.new(method, pathWithQuery, scheme, authority, body, options)`
// factory and a `RequestOptions.new()` static factory. Neither exists on the
// real shim (see tests/wasi-http.test.mjs's `makeRequest` helper) — the real
// `Request.new(headers, contents, trailers, options)` returns a
// `[Request, Promise<Result<...>>]` tuple with method/scheme/authority/path
// set via setters afterward, and `RequestOptions` has a public constructor,
// not a static `new`. Built this helper against the real signatures.
function get(url) {
  const u = new URL(url);
  const headers = new Fields();
  const trailers = Promise.resolve({ tag: 'ok', val: undefined });
  const [req] = Request.new(headers, undefined, trailers, new RequestOptions());
  req.setMethod({ tag: 'get' });
  req.setScheme({ tag: u.protocol === 'https:' ? 'HTTPS' : 'HTTP' });
  req.setAuthority(u.host);
  req.setPathWithQuery(u.pathname + u.search);
  return req;
}

// Like `get()` but for authorities `new URL()` can't round-trip cleanly (e.g.
// a bracketed IPv6 literal with no port — `new URL('https://[::1]/x').host`
// normalizes to `[::1]`, which is fine, but keeping this parallel to `get()`
// with an explicit authority param avoids relying on URL's IPv6 handling at
// all and lets callers pass a port-bearing authority like `[::1]:8443` too).
function getWithAuthority(scheme, authority, pathWithQuery) {
  const headers = new Fields();
  const trailers = Promise.resolve({ tag: 'ok', val: undefined });
  const [req] = Request.new(headers, undefined, trailers, new RequestOptions());
  req.setMethod({ tag: 'get' });
  req.setScheme({ tag: scheme === 'https' ? 'HTTPS' : 'HTTP' });
  req.setAuthority(authority);
  req.setPathWithQuery(pathWithQuery);
  return req;
}

test('deny blocks the fetch (fetch never invoked) and throws a WIT error-code', async () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (...args) => { fetchCalls++; return realFetch(...args); };
  __setActivePolicy({ async decideHttp() { return 'deny'; } });
  try {
    await assert.rejects(() => client.send(get('https://blocked.example.com/x')), (e) => {
      assert.equal(e && e.tag, 'internal-error'); // raw WIT error, not Error
      return true;
    });
    assert.equal(fetchCalls, 0, 'fetch must not be called when policy denies');
  } finally {
    __setActivePolicy(null);
    globalThis.fetch = realFetch;
  }
});

test('IPv6 authority without a port yields host with brackets + default port', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  agent.get('https://[::1]').intercept({ path: '/x', method: 'GET' }).reply(200, 'hi');
  let capturedOp;
  __setActivePolicy({
    async decideHttp(op) {
      capturedOp = op;
      return 'allow';
    },
  });
  try {
    const resp = await client.send(getWithAuthority('https', '[::1]', '/x'));
    assert.equal(resp.getStatusCode(), 200);
    assert.equal(capturedOp && capturedOp.key, '[::1]:443');
  } finally {
    __setActivePolicy(null);
  }
  await agent.close();
});

test('IPv6 authority with an explicit port keeps host bracketed + uses that port', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  agent.get('https://[::1]:8443').intercept({ path: '/x', method: 'GET' }).reply(200, 'hi');
  let capturedOp;
  __setActivePolicy({
    async decideHttp(op) {
      capturedOp = op;
      return 'allow';
    },
  });
  try {
    const resp = await client.send(getWithAuthority('https', '[::1]:8443', '/x'));
    assert.equal(resp.getStatusCode(), 200);
    assert.equal(capturedOp && capturedOp.key, '[::1]:8443');
  } finally {
    __setActivePolicy(null);
  }
  await agent.close();
});

test('allow proceeds to fetch', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  agent.get('https://ok.example.com').intercept({ path: '/x', method: 'GET' }).reply(200, 'hi');
  __setActivePolicy({ async decideHttp() { return 'allow'; } });
  try {
    const resp = await client.send(get('https://ok.example.com/x'));
    assert.equal(resp.getStatusCode(), 200);
  } finally {
    __setActivePolicy(null);
  }
  await agent.close();
});

test('no active policy = pass-through (unchanged legacy behavior)', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  agent.get('https://legacy.example.com').intercept({ path: '/x', method: 'GET' }).reply(204, '');
  __setActivePolicy(null);
  const resp = await client.send(get('https://legacy.example.com/x'));
  assert.equal(resp.getStatusCode(), 204);
  await agent.close();
});
