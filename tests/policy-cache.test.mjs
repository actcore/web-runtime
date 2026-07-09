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
