/**
 * @actcore/web-runtime — browser host for ACT (Agent Component Tools).
 *
 * Loads ACT wasm components in a browser tab via {@link
 * https://github.com/bytecodealliance/jco | jco}'s in-browser transpiler and
 * exposes the component's `act:tools/tool-provider` as a typed JS object.
 *
 * @example
 * ```ts
 * import { runComponent } from '@actcore/web-runtime';
 *
 * const wasm = new Uint8Array(await (await fetch('/time.wasm')).arrayBuffer());
 * const { toolProvider } = await runComponent(wasm);
 *
 * const { tools } = await toolProvider.listTools([]);
 * const result = await toolProvider.callTool('get_current_time', new Uint8Array([0xa0]), []);
 * ```
 */

export type {
  ToolDefinition,
  ContentPart,
  ToolEvent,
  ToolEventContent,
  ToolEventError,
  ListToolsResponse,
} from './generated/interfaces/act-tools-types.js';
export type {
  ToolResult,
  ToolResultImmediate,
  ToolResultStreaming,
} from './generated/interfaces/act-tools-tool-provider.js';
export type {
  Cbor,
  LocalizedString,
  LocalizedStringPlain,
  LocalizedStringLocalized,
  Metadata,
  Error as ActError,
} from './generated/interfaces/act-core-types.js';
export type {
  Session,
} from './generated/interfaces/act-sessions-types.js';

export type { RunComponentOptions, ComponentInstance, ToolProvider } from './host-api.js';
export { runComponent } from './host-api.js';

export { clearTranspileCache } from './cache.js';

export type { ResolveLocalizedStringOptions } from './locale.js';
export { resolveLocalizedString } from './locale.js';

export { isWebmcpAvailable, exposeToWebmcp } from './webmcp.js';
export type {
  ModelContext,
  WebmcpToolDescriptor,
  WebmcpCallResult,
  ExposeWebmcpOptions,
  WebmcpExposure,
} from './webmcp.js';

export type { PolicyConfig, ConsentAsk, Verdict, AuditRecord, ResourceOp } from './policy/types.js';
