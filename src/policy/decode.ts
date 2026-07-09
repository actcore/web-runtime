import { decode } from 'cbor2';

const SECTION = 'act:component';

function isWasmPreamble(b: Uint8Array, o: number): boolean {
  return b[o] === 0x00 && b[o + 1] === 0x61 && b[o + 2] === 0x73 && b[o + 3] === 0x6d;
}

// LEB128 unsigned. Returns [value, nextOffset].
function readLeb(b: Uint8Array, o: number): [number, number] {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = b[o++]!;
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return [result >>> 0, o];
}

// Walk wasm/component sections starting at `start` (which must be a wasm/component
// preamble). Returns the `act:component` custom-section payload bytes, or null.
// Recurses into any section whose payload is itself an embedded wasm module
// (the component's core-module section), which is where act-build packs the section.
function findSectionPayload(b: Uint8Array, start: number, end: number): Uint8Array | null {
  if (end - start < 8 || !isWasmPreamble(b, start)) return null;
  let o = start + 8; // skip 8-byte preamble (magic + version/layer)
  while (o < end) {
    const id = b[o++]!;
    let size: number;
    [size, o] = readLeb(b, o);
    const payloadStart = o;
    const payloadEnd = o + size;
    if (payloadEnd > end) break; // malformed
    if (id === 0) {
      // custom section: LEB name-length, name bytes, then data
      let nameLen: number;
      let nameOff: number;
      [nameLen, nameOff] = readLeb(b, payloadStart);
      const name = new TextDecoder().decode(b.subarray(nameOff, nameOff + nameLen));
      if (name === SECTION) return b.subarray(nameOff + nameLen, payloadEnd);
    } else if (isWasmPreamble(b, payloadStart)) {
      const nested = findSectionPayload(b, payloadStart, payloadEnd);
      if (nested) return nested;
    }
    o = payloadEnd;
  }
  return null;
}

/**
 * Extracts the component's declared `std.capabilities` map from the `act:component`
 * CBOR custom section, found by walking the component/core-module section framing
 * directly (component-model binaries can't be passed to `WebAssembly.compile`, and
 * act-build packs the section inside the embedded core module). Returns `{}` when
 * the section is absent or unreadable — the component then can't use gated caps.
 */
export async function decodeDeclaredCaps(bytes: Uint8Array): Promise<Record<string, unknown>> {
  let payload: Uint8Array | null;
  try {
    payload = findSectionPayload(bytes, 0, bytes.length);
  } catch {
    return {};
  }
  if (!payload) return {};
  try {
    const info = decode(payload) as { std?: { capabilities?: Record<string, unknown> } };
    return info?.std?.capabilities ?? {};
  } catch {
    return {};
  }
}
