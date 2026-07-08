/**
 * Bridge: expose an ACT component's tools on the browser's native WebMCP
 * surface (`document.modelContext`). Native-only, feature-gated, opt-in.
 *
 * WebMCP is pre-standardization; we type only the slice we depend on
 * (`registerTool` + `AbortSignal`) so upstream churn cannot break the build.
 * Spec: https://webmachinelearning.github.io/webmcp/
 */

import { decode, encode } from 'cbor2';
import type { Metadata } from './generated/interfaces/act-core-types.js';
import type { ToolProvider } from './host-api.js';
import type { ToolDefinition, ToolEvent } from './generated/interfaces/act-tools-types.js';
import type { ToolResult } from './generated/interfaces/act-tools-tool-provider.js';
import { resolveLocalizedString } from './locale.js';

/** MCP-style result an `execute` handler returns. */
export interface WebmcpCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** A single WebMCP tool descriptor passed to `registerTool`. */
export interface WebmcpToolDescriptor {
  name: string;
  description: string;
  title?: string;
  inputSchema?: object;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<WebmcpCallResult>;
}

interface RegisterToolOptions {
  signal?: AbortSignal;
  exposedTo?: string[];
}

/** The slice of the native `document.modelContext` surface we use. */
export interface ModelContext {
  registerTool(tool: WebmcpToolDescriptor, options?: RegisterToolOptions): Promise<void>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
  }
}

/** Native WebMCP surface if present (canonical `document`, legacy `navigator`). */
export function getModelContext(): ModelContext | null {
  if (typeof document !== 'undefined' && document.modelContext) return document.modelContext;
  if (typeof navigator !== 'undefined' && navigator.modelContext) return navigator.modelContext;
  return null;
}

/** True when the browser exposes a native WebMCP surface. */
export function isWebmcpAvailable(): boolean {
  return getModelContext() !== null;
}

/** Coerce an ACT tool name to WebMCP's `[A-Za-z0-9_.-]`, ≤128, non-empty. */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return cleaned || 'tool';
}

/** ACT `parameters-schema` (a JSON Schema string) → a JSON Schema object. */
export function parseInputSchema(schemaStr: string): object {
  if (schemaStr && schemaStr.trim()) {
    try {
      const parsed = JSON.parse(schemaStr);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as object;
    } catch {
      /* fall through to default */
    }
  }
  return { type: 'object', properties: {} };
}

/** Read the `std:read-only` boolean from ACT tool metadata, if present. */
export function readReadOnlyHint(metadata: Metadata): boolean | undefined {
  for (const [key, val] of metadata) {
    if (key === 'std:read-only') {
      try {
        const decoded = decode(val);
        if (typeof decoded === 'boolean') return decoded;
      } catch {
        /* ignore undecodable value */
      }
    }
  }
  return undefined;
}

/** WebMCP annotations for an ACT tool: readOnly from meta, untrusted by default. */
export function buildAnnotations(
  metadata: Metadata,
): { readOnlyHint?: boolean; untrustedContentHint: boolean } {
  const readOnly = readReadOnlyHint(metadata);
  return {
    ...(readOnly !== undefined ? { readOnlyHint: readOnly } : {}),
    untrustedContentHint: true,
  };
}

/** Options for {@link exposeToWebmcp}. */
export interface ExposeWebmcpOptions {
  /** Current session id, read per invocation; when set, forwarded as
   *  `std:session-id` metadata on every callTool. */
  getSessionId?: () => string | null | undefined;
  /** WebMCP `exposedTo` origin allowlist. Omit for default visibility. */
  exposedTo?: string[];
}

/** wasi:http content-parts surface mimeType as an `option<string>` variant
 *  (`{tag:'some',val}`) rather than a plain string; normalise both. */
function normalizeMime(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && (raw as { tag?: string }).tag === 'some') {
    return String((raw as { val: string }).val);
  }
  return 'application/octet-stream';
}

function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(Array.isArray(data) ? (data as number[]) : []);
}

/** Collect a ToolResult's events (immediate array or streaming ReadableStream)
 *  into a single text blob, flagging whether a terminal error occurred. */
async function drainToText(result: ToolResult): Promise<{ text: string; isError: boolean }> {
  const events: ToolEvent[] = [];
  if (result.tag === 'immediate') {
    events.push(...result.val);
  } else {
    // Typed as ReadableStream, but accept an already-drained array too — some intermediaries
    // normalise streaming→immediate (mirrors normalizeMime's static-vs-runtime note).
    const val = result.val as unknown as ReadableStream<ToolEvent> | ToolEvent[];
    if (Array.isArray(val)) {
      events.push(...val);
    } else {
      const reader = val.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) events.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
  }

  const parts: string[] = [];
  let isError = false;
  for (const ev of events) {
    if (ev.tag === 'content') {
      const mime = normalizeMime(ev.val.mimeType);
      const data = asBytes(ev.val.data);
      if (mime.startsWith('text/') || mime === 'application/json') {
        parts.push(new TextDecoder().decode(data));
      } else {
        parts.push(`(${mime}, ${data.length} bytes)`);
      }
    } else {
      isError = true;
      parts.push(`error: ${ev.val.kind} · ${resolveLocalizedString(ev.val.message)}`);
    }
  }
  return { text: parts.join('\n'), isError };
}

/** Build the WebMCP `execute` handler that bridges to `ToolProvider.callTool`. */
export function buildExecute(
  provider: ToolProvider,
  def: ToolDefinition,
  options: ExposeWebmcpOptions,
): (input: Record<string, unknown>) => Promise<WebmcpCallResult> {
  return async (input) => {
    try {
      const argBytes = encode(input ?? {}, { dcbor: true });
      // Forward std:session-id only for a non-empty session id; null,
      // undefined, and "" (a meaningless id) are all omitted.
      const sessionId = options.getSessionId?.();
      const meta: Metadata = sessionId
        ? [['std:session-id', encode(sessionId, { dcbor: true })]]
        : [];
      const result = await provider.callTool(def.name, argBytes, meta);
      const { text, isError } = await drainToText(result);
      return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  };
}

/** Map one ACT ToolDefinition to a WebMCP descriptor (execute included). */
export function toDescriptor(
  provider: ToolProvider,
  def: ToolDefinition,
  options: ExposeWebmcpOptions,
): WebmcpToolDescriptor {
  return {
    name: sanitizeName(def.name),
    description: resolveLocalizedString(def.description),
    inputSchema: parseInputSchema(def.parametersSchema),
    annotations: buildAnnotations(def.metadata),
    execute: buildExecute(provider, def, options),
  };
}

/** Handle returned by {@link exposeToWebmcp}. */
export interface WebmcpExposure {
  /** Number of tools successfully registered (0 when unavailable). */
  count: number;
  /** False when no native WebMCP surface was present. */
  available: boolean;
  /** Unregister all tools (aborts the registration signal). Idempotent. */
  dispose(): void;
}

/**
 * Register every tool of an ACT component on the native WebMCP surface.
 * Opt-in and headless — the caller decides when to call it and renders any UI.
 * No-ops (returns `available:false`) where `document.modelContext` is absent.
 * Call `dispose()` before re-exposing a different component.
 */
export async function exposeToWebmcp(
  provider: ToolProvider,
  tools: ToolDefinition[],
  options: ExposeWebmcpOptions = {},
): Promise<WebmcpExposure> {
  const mc = getModelContext();
  if (!mc) return { count: 0, available: false, dispose() {} };

  const controller = new AbortController();
  let count = 0;
  for (const def of tools) {
    try {
      const descriptor = toDescriptor(provider, def, options);
      await mc.registerTool(descriptor, {
        signal: controller.signal,
        ...(options.exposedTo ? { exposedTo: options.exposedTo } : {}),
      });
      count++;
    } catch (err) {
      console.warn(`[webmcp] registerTool for "${def.name}" failed:`, err);
    }
  }
  return { count, available: true, dispose: () => controller.abort() };
}
