import test from 'node:test';
import assert from 'node:assert/strict';
import { Kernel } from '../dist/policy/kernel.js';

test('kernel classifies http allowlist in-ceiling as allow', async () => {
  await Kernel.load();
  const declared = JSON.stringify({ 'wasi:http': { constraints: [{ host: 'api.example.com' }] } });
  const policy = JSON.stringify({ default: 'deny', 'wasi:http': { mode: 'allowlist', allow: [{ host: 'api.example.com' }] } });
  const h = Kernel.build(declared, policy);
  const op = JSON.stringify({ capId: 'wasi:http', key: 'api.example.com:443', action: 'GET', attrs: { scheme: 'https' } });
  assert.equal(h.classify(op), 'allow');
});

test('kernel denies off-allowlist host', async () => {
  await Kernel.load();
  const declared = JSON.stringify({ 'wasi:http': { constraints: [{ host: 'api.example.com' }] } });
  const policy = JSON.stringify({ default: 'deny', 'wasi:http': { mode: 'allowlist', allow: [{ host: 'api.example.com' }] } });
  const h = Kernel.build(declared, policy);
  const op = JSON.stringify({ capId: 'wasi:http', key: 'evil.example.com:443', action: 'GET', attrs: { scheme: 'https' } });
  assert.equal(h.classify(op), 'deny');
});
