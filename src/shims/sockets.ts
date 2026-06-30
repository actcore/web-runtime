/**
 * Browser wasi:sockets shim for @actcore/host.
 *
 * preview2-shim's browser build ships wasi:sockets as method-only stub objects
 * that OMIT the resource-class constructors (ResolveAddressStream, Network,
 * TcpSocket, UdpSocket, IncomingDatagramStream, OutgoingDatagramStream). jco's
 * generated glue destructures those classes at instantiation
 * (`const { ResolveAddressStream } = ipNameLookup`) and throws
 * "unexpectedly undefined local import" if they're missing — which any
 * wasi:http-importing component (whose wasip3 world transitively pulls in
 * wasi:sockets) triggers even when it never touches the network.
 *
 * This shim provides the full export surface WITH the resource classes as inert
 * stubs. Sockets/DNS are never actually exercised by the pure-compute components
 * we run in the tab; the constructors only need to EXIST so instantiation
 * succeeds. host-browser routes `wasi:sockets/*` here (see transpile.ts) instead
 * of at the preview2-shim base.
 *
 * DENY, DON'T CRASH: the three resource-creation entry points below —
 * `resolveAddresses` (DNS), `createTcpSocket`, `createUdpSocket` — are the only
 * ways guest code can ever obtain a live socket/lookup resource; every other
 * method in this file is unreachable unless one of those three succeeds. Their
 * WIT signatures return `result<_, error-code>`, and jco's generated glue wraps
 * each call in `try { ... } catch (e) { ret = { tag: 'err', val:
 * getErrorPayload(e) } }` — but `getErrorPayload` only treats `e` as the error
 * payload if `e` is NOT a plain `Error` (a thrown `Error` gets RE-THROWN
 * uncaught instead of becoming a clean `result::err`, verified by reading the
 * transpiled glue). So denial must throw the raw `error-code` string value
 * (e.g. `'access-denied'`), never `new Error(...)` — a plain Error here
 * doesn't deny the call, it corrupts the CPython/JSPI interpreter state
 * (`Fatal Python error: ... the GIL is released`), which is worse than useless
 * for a "sealed sandbox" story. Everything else in this file stays a bare
 * no-op stub: unreachable code, so its shape doesn't matter.
 *
 * `instance-network()` is the one exception to "deny at the entry point": its
 * WIT signature is `func() -> network` — no `result<>`, so it has NO error
 * channel at all (getting the ambient network capability TOKEN is defined to
 * never fail; the denial belongs at the point that token is actually used).
 * It must return a real `Network` instance — returning `undefined` fails the
 * caller's `instanceof Network` check with an uncaught "Resource error: Not a
 * valid Network resource", which (same as above) never reaches Python as a
 * clean exception. `Network` is declared once here so `instanceNetwork()` and
 * `network.Network` share the identical class the generated glue checks
 * `instanceof` against.
 */

function denyAccess(): never {
  throw 'access-denied';
}

class Network {}

export const instanceNetwork = {
  instanceNetwork() {
    return new Network();
  },
};

export const ipNameLookup = {
  ResolveAddressStream: class ResolveAddressStream {},
  dropResolveAddressStream() {},
  subscribe() {},
  resolveAddresses: denyAccess,
  resolveNextAddress() {},
  nonBlocking() {},
  setNonBlocking() {},
};

export const network = {
  Network,
  dropNetwork() {},
};

export const tcpCreateSocket = {
  createTcpSocket: denyAccess,
};

export const tcp = {
  TcpSocket: class TcpSocket {},
  subscribe() {},
  dropTcpSocket() {},
  bind() {},
  connect() {},
  listen() {},
  accept() {},
  localAddress() {},
  remoteAddress() {},
  addressFamily() {},
  setListenBacklogSize() {},
  keepAlive() {},
  setKeepAlive() {},
  noDelay() {},
  setNoDelay() {},
  unicastHopLimit() {},
  setUnicastHopLimit() {},
  receiveBufferSize() {},
  setReceiveBufferSize() {},
  sendBufferSize() {},
  setSendBufferSize() {},
  nonBlocking() {},
  setNonBlocking() {},
  shutdown() {},
};

export const udpCreateSocket = {
  createUdpSocket: denyAccess,
};

export const udp = {
  UdpSocket: class UdpSocket {},
  IncomingDatagramStream: class IncomingDatagramStream {},
  OutgoingDatagramStream: class OutgoingDatagramStream {},
  subscribe() {},
  dropUdpSocket() {},
  bind() {},
  connect() {},
  receive() {},
  send() {},
  localAddress() {},
  remoteAddress() {},
  addressFamily() {},
  unicastHopLimit() {},
  setUnicastHopLimit() {},
  receiveBufferSize() {},
  setReceiveBufferSize() {},
  sendBufferSize() {},
  setSendBufferSize() {},
  nonBlocking() {},
  setNonBlocking() {},
};
