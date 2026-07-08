import test from 'node:test';
import assert from 'node:assert/strict';
import { tcpCreateSocket, __setSocketsPolicy } from '../dist/shims/sockets.js';

test('createTcpSocket still throws access-denied and notes the denial', () => {
  let noted = 0;
  __setSocketsPolicy({ noteSocketsDenied() { noted++; } });
  try {
    assert.throws(() => tcpCreateSocket.createTcpSocket(), (e) => e === 'access-denied');
    assert.equal(noted, 1);
  } finally {
    __setSocketsPolicy(null);
  }
});

test('no policy set = still throws access-denied (unchanged)', () => {
  __setSocketsPolicy(null);
  assert.throws(() => tcpCreateSocket.createTcpSocket(), (e) => e === 'access-denied');
});
