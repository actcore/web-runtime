/**
 * Bridge: expose an ACT component's tools on the browser's native WebMCP
 * surface (`document.modelContext`). Native-only, feature-gated, opt-in.
 *
 * WebMCP is pre-standardization; we type only the slice we depend on
 * (`registerTool` + `AbortSignal`) so upstream churn cannot break the build.
 * Spec: https://webmachinelearning.github.io/webmcp/
 */

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
