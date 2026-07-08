import { decode } from 'cbor2';

const SECTION = 'act:component';

/**
 * Extracts the component's declared `std.capabilities` map from the
 * `act:component` CBOR custom section. Returns `{}` when the section is
 * absent or unreadable (the component simply cannot use gated capabilities).
 *
 * Uses `WebAssembly.Module.customSections`, which reads sections without
 * running the module. Compilation here is cheap relative to the JSPI
 * instantiation that follows.
 */
export async function decodeDeclaredCaps(bytes: Uint8Array): Promise<Record<string, unknown>> {
  let sections: ArrayBuffer[];
  try {
    // `Uint8Array` (bare) widens to `Uint8Array<ArrayBufferLike>`, which
    // admits `SharedArrayBuffer` — `BufferSource` (TS 5.7+) requires the
    // narrower `ArrayBufferView<ArrayBuffer>`. Assert: we only ever pass
    // component bytes backed by a plain `ArrayBuffer`.
    const mod = await WebAssembly.compile(bytes as BufferSource);
    sections = WebAssembly.Module.customSections(mod, SECTION);
  } catch {
    return {};
  }
  if (sections.length === 0) return {};
  try {
    const info = decode(new Uint8Array(sections[0]!)) as {
      std?: { capabilities?: Record<string, unknown> };
    };
    return info?.std?.capabilities ?? {};
  } catch {
    return {};
  }
}
