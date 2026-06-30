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
 */

export const instanceNetwork = {
  instanceNetwork() {},
};

export const ipNameLookup = {
  ResolveAddressStream: class ResolveAddressStream {},
  dropResolveAddressStream() {},
  subscribe() {},
  resolveAddresses() {},
  resolveNextAddress() {},
  nonBlocking() {},
  setNonBlocking() {},
};

export const network = {
  Network: class Network {},
  dropNetwork() {},
};

export const tcpCreateSocket = {
  createTcpSocket() {},
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
  createUdpSocket() {},
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
