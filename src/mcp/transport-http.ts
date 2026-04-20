/**
 * HTTP transport for MCP (Streamable HTTP).
 *
 * Spec: https://modelcontextprotocol.io/specification/basic/transports#streamable-http
 *
 * Each `send()` POSTs the JSON-RPC message to the server. The response is:
 *   - 202 Accepted         → notification ack, no body
 *   - 200 application/json → single JSON-RPC response, parsed and forwarded
 *   - 200 text/event-stream → SSE stream, each `data:` line is a JSON-RPC message
 *
 * Session IDs (`Mcp-Session-Id` header) are captured from the initial response
 * and echoed on subsequent requests.
 *
 * Server-initiated requests via GET SSE are not supported yet.
 */

import { logger } from '../utils/logger';
import { JsonRpcMessage, McpHttpConfig, McpTransport } from './types';

const SESSION_HEADER = 'mcp-session-id';

export class HttpTransport implements McpTransport {
  private readonly _config: McpHttpConfig;
  private readonly _label: string;

  private _sessionId?: string;
  private _onMessage?: (msg: JsonRpcMessage) => void;
  private _onError?: (err: Error) => void;
  private _onClose?: () => void;
  private _closed = false;
  private _activeStreams = new Set<AbortController>();

  constructor(config: McpHttpConfig, label = 'http') {
    this._config = config;
    this._label = label;
  }

  // ── McpTransport ───────────────────────────────────────────────────────────

  async send(message: JsonRpcMessage): Promise<void> {
    if (this._closed) throw new Error(`[${this._label}] transport closed`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...this._config.headers,
    };
    if (this._sessionId) headers[SESSION_HEADER] = this._sessionId;

    const controller = new AbortController();
    this._activeStreams.add(controller);

    let res: Response;
    try {
      res = await fetch(this._config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (err) {
      this._activeStreams.delete(controller);
      throw err instanceof Error ? err : new Error(String(err));
    }

    // Capture session id on first successful response.
    const sid = res.headers.get(SESSION_HEADER);
    if (sid && !this._sessionId) this._sessionId = sid;

    if (!res.ok) {
      this._activeStreams.delete(controller);
      const body = await res.text().catch(() => '');
      throw new Error(`[${this._label}] HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }

    if (res.status === 202) {
      this._activeStreams.delete(controller);
      return; // notification ack
    }

    const contentType = res.headers.get('content-type') ?? '';

    if (contentType.includes('text/event-stream')) {
      // Keep streaming in the background — do NOT await. The JSON-RPC client
      // correlates responses by ID, so send() returns once the request is
      // accepted, and incoming messages flow through onMessage.
      this._consumeSse(res, controller).catch((err) => {
        if (!this._closed) this._fail(err);
      });
      return;
    }

    // application/json (or unspecified — treat as JSON).
    try {
      const parsed = await res.json() as JsonRpcMessage | JsonRpcMessage[];
      if (Array.isArray(parsed)) {
        for (const m of parsed) this._onMessage?.(m);
      } else {
        this._onMessage?.(parsed);
      }
    } catch (err) {
      throw new Error(`[${this._label}] invalid JSON response: ${(err as Error).message}`);
    } finally {
      this._activeStreams.delete(controller);
    }
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this._onMessage = handler;
  }

  onError(handler: (err: Error) => void): void {
    this._onError = handler;
  }

  onClose(handler: () => void): void {
    this._onClose = handler;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    for (const controller of this._activeStreams) {
      try { controller.abort(); } catch { /* ignore */ }
    }
    this._activeStreams.clear();
    this._onClose?.();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async _consumeSse(res: Response, controller: AbortController): Promise<void> {
    if (!res.body) {
      this._activeStreams.delete(controller);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let eventEnd: number;
        while ((eventEnd = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          this._dispatchSseEvent(rawEvent);
        }
      }
    } finally {
      this._activeStreams.delete(controller);
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  private _dispatchSseEvent(rawEvent: string): void {
    // Collect `data:` lines. Per the SSE spec, multiple data lines are joined
    // with '\n'. Other fields (event:, id:, retry:) are ignored for now.
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length === 0) return;

    const payload = dataLines.join('\n');
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(payload) as JsonRpcMessage;
    } catch {
      logger.warn(`[${this._label}] invalid SSE data: ${payload.slice(0, 200)}`);
      return;
    }
    this._onMessage?.(parsed);
  }

  private _fail(err: Error): void {
    if (this._closed) return;
    this._closed = true;
    this._onError?.(err);
  }
}
