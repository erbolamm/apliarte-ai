/**
 * Transport-agnostic JSON-RPC 2.0 client.
 *
 * Correlates requests with responses by ID, enforces timeouts, surfaces
 * JSON-RPC errors as typed exceptions. Knows nothing about stdio vs HTTP —
 * that is the transport's job.
 *
 * Usage:
 *   const client = new JsonRpcClient(transport);
 *   const tools = await client.request<{ tools: McpTool[] }>('tools/list');
 */

import { logger } from '../utils/logger';
import {
  JsonRpcError,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  McpTransport,
} from './types';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface JsonRpcClientOptions {
  /** Default timeout per request in ms. Overridable per call. */
  defaultTimeoutMs?: number;
  /** Optional label used in log lines (e.g. the server name). */
  label?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class JsonRpcClient {
  private readonly _transport: McpTransport;
  private readonly _pending = new Map<JsonRpcId, Pending>();
  private readonly _timeoutMs: number;
  private readonly _label: string;
  private readonly _closeHandlers: Array<(reason: Error) => void> = [];

  private _nextId = 1;
  private _closed = false;

  constructor(transport: McpTransport, opts: JsonRpcClientOptions = {}) {
    this._transport = transport;
    this._timeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._label = opts.label ?? 'mcp';

    this._transport.onMessage((msg) => this._handleIncoming(msg));
    this._transport.onError((err) => {
      if (this._closed) return;
      this._failAll(err);
      this._fireClose(err);
    });
    this._transport.onClose(() => {
      if (this._closed) return;
      const err = new Error('transport closed');
      this._failAll(err);
      this._fireClose(err);
    });
  }

  /** Register a handler for transport-level close/error. Multiple allowed. */
  onClose(handler: (reason: Error) => void): void {
    this._closeHandlers.push(handler);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Send a request and await its response.
   * Throws JsonRpcError on server-side failure, generic Error on timeout/transport.
   */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (this._closed) {
      throw new Error(`[${this._label}] client closed`);
    }

    const id = this._nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) };
    const limit = timeoutMs ?? this._timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`[${this._label}] ${method} timed out after ${limit}ms`));
      }, limit);

      this._pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });

      this._transport.send(req).catch((err) => {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Fire-and-forget notification (no response expected). */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this._closed) {
      throw new Error(`[${this._label}] client closed`);
    }
    const note: JsonRpcNotification = { jsonrpc: '2.0', method, ...(params !== undefined && { params }) };
    await this._transport.send(note);
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._failAll(new Error('client closed'));
    await this._transport.close();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private _handleIncoming(msg: JsonRpcMessage): void {
    // Only responses are routed to pending requests. Server-initiated requests
    // (e.g. sampling/createMessage) would need a separate handler path; we
    // ignore them for now.
    if (!('id' in msg) || msg.id === undefined || msg.id === null) {
      logger.info(`[${this._label}] ignoring message without id`);
      return;
    }
    if (!('result' in msg) && !('error' in msg)) {
      // It's a request from the server — not supported yet.
      logger.info(`[${this._label}] server-initiated request ignored (method=${(msg as JsonRpcRequest).method})`);
      return;
    }

    const response = msg as JsonRpcResponse;
    const id = response.id;
    if (id === null) {
      logger.warn(`[${this._label}] received error with null id: ${JSON.stringify((response as JsonRpcFailure).error)}`);
      return;
    }

    const pending = this._pending.get(id);
    if (!pending) {
      logger.warn(`[${this._label}] response for unknown id=${String(id)}`);
      return;
    }

    this._pending.delete(id);
    clearTimeout(pending.timer);

    if ('error' in response) {
      pending.reject(new JsonRpcError(response.error));
    } else {
      pending.resolve((response as JsonRpcSuccess).result);
    }
  }

  private _failAll(error: Error): void {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this._pending.clear();
  }

  private _fireClose(reason: Error): void {
    const handlers = this._closeHandlers.splice(0);
    for (const h of handlers) {
      try { h(reason); } catch { /* swallow handler errors */ }
    }
  }
}
