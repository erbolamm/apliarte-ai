/**
 * MCP (Model Context Protocol) types.
 *
 * Based on the JSON-RPC 2.0 spec (https://www.jsonrpc.org/specification)
 * and the MCP spec (https://spec.modelcontextprotocol.io).
 *
 * Transport-agnostic — stdio, HTTP/SSE, and anything else reuse these types.
 */

// ── JSON-RPC 2.0 ──────────────────────────────────────────────────────────────

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorPayload;
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcFailure;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

// Standard JSON-RPC error codes (§5.1).
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(payload: JsonRpcErrorPayload) {
    super(payload.message);
    this.name = 'JsonRpcError';
    this.code = payload.code;
    this.data = payload.data;
  }
}

// ── Transport abstraction ─────────────────────────────────────────────────────

/**
 * A transport is a full-duplex channel that carries framed JSON-RPC messages.
 * The client does not know whether it's stdio, HTTP/SSE, websockets, etc.
 */
export interface McpTransport {
  /** Send a message to the remote peer. */
  send(message: JsonRpcMessage): Promise<void>;

  /**
   * Register a handler for incoming messages.
   * Called once — the transport keeps the single handler reference.
   */
  onMessage(handler: (message: JsonRpcMessage) => void): void;

  /** Register a handler for transport-level errors (I/O, parse, process exit). */
  onError(handler: (error: Error) => void): void;

  /** Register a handler for clean close. */
  onClose(handler: () => void): void;

  /** Close the channel. Idempotent. */
  close(): Promise<void>;
}

// ── MCP domain types ──────────────────────────────────────────────────────────

/** MCP `tools/list` entry. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;   // JSON Schema for arguments
}

/** MCP `tools/call` request params. */
export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** MCP `tools/call` result content block. */
export interface McpToolResultContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

/** MCP `tools/call` response. */
export interface McpToolCallResult {
  content: McpToolResultContent[];
  isError?: boolean;
}

// ── Server configuration ──────────────────────────────────────────────────────

/** User-facing config for a single MCP server (read from VS Code settings). */
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpStdioConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}
