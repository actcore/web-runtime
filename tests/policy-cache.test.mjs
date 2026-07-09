import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionCache } from '../dist/policy/cache.js';

test('session-scope remembers within the instance, not persisted', () => {
  const c = new DecisionCache('origin|ref|digest', 'none');
  assert.equal(c.get('wasi:http|h:443|GET'), undefined);
  c.put('wasi:http|h:443|GET', { allow: true, remember: 'session' });
  assert.equal(c.get('wasi:http|h:443|GET'), 'allow');
});

test('once-scope is not remembered', () => {
  const c = new DecisionCache('origin|ref|digest', 'none');
  c.put('wasi:http|h:443|GET', { allow: true, remember: 'once' });
  assert.equal(c.get('wasi:http|h:443|GET'), undefined);
});

test('deny verdicts are remembered too', () => {
  const c = new DecisionCache('origin|ref|digest', 'none');
  c.put('wasi:http|h:443|GET', { allow: false, remember: 'session' });
  assert.equal(c.get('wasi:http|h:443|GET'), 'deny');
});

test('persistPayload excludes session-scoped entries, includes always-scoped ones', () => {
  const c = new DecisionCache('origin|ref|digest', 'local');
  c.put('k1', { allow: true, remember: 'session' });
  c.put('k2', { allow: true, remember: 'always' });
  assert.deepEqual(c.persistPayload({}), { k2: 'allow' });
});

test('persistPayload read-modify-write preserves prior persisted entries', () => {
  const c = new DecisionCache('origin|ref|digest', 'local');
  c.put('k1', { allow: true, remember: 'session' });
  c.put('k2', { allow: true, remember: 'always' });
  assert.deepEqual(c.persistPayload({ k0: 'deny' }), { k0: 'deny', k2: 'allow' });
});

test('session decision is in-memory-visible but not durable', () => {
  const c = new DecisionCache('origin|ref|digest', 'local');
  c.put('k1', { allow: true, remember: 'session' });
  c.put('k2', { allow: true, remember: 'always' });
  assert.equal(c.get('k1'), 'allow');
});
