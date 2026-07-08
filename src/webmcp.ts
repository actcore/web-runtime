/**
 * Bridge: expose an ACT component's tools on the browser's native WebMCP
 * surface (`document.modelContext`). Native-only, feature-gated, opt-in.
 *
 * WebMCP is pre-standardization; we type only the slice we depend on
 * (`registerTool` + `AbortSignal`) so upstream churn cannot break the build.
 * Spec: https://webmachinelearning.github.io/webmcp/
 */

import { decode } from 'cbor2';
import type { Metadata } from './generated/interfaces/act-core-types.js';

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
      if (parsed && typeof parsed === 'object') return parsed as object;
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
