/**
 * Stdio transport for MCP.
 *
 * Frames JSON-RPC messages as newline-delimited JSON over the child process's
 * stdin/stdout. This matches the MCP spec's stdio transport.
 *
 * stderr is forwarded to the logger for debug visibility (most MCP servers
 * write their structured logs there).
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { logger } from '../utils/logger';
import { JsonRpcMessage, McpStdioConfig, McpTransport } from './types';

export class StdioTransport implements McpTransport {
  private readonly _config: McpStdioConfig;
  private readonly _label: string;

  private _child?: ChildProcessWithoutNullStreams;
  private _stdoutBuffer = '';
  private _onMessage?: (msg: JsonRpcMessage) => void;
  private _onError?: (err: Error) => void;
  private _onClose?: () => void;
  private _closed = false;

  constructor(config: McpStdioConfig, label = 'stdio') {
    this._config = config;
    this._label = label;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Spawn the child process. Must be called before send(). */
  async start(): Promise<void> {
    if (this._child) throw new Error(`[${this._label}] already started`);

    const env = { ...process.env, ...(this._config.env ?? {}) };
    this._child = spawn(this._config.command, this._config.args ?? [], {
      env,
      cwd: this._config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._child.stdout.setEncoding('utf8');
    this._child.stdout.on('data', (chunk: string) => this._onStdout(chunk));
    this._child.stderr.setEncoding('utf8');
    this._child.stderr.on('data', (chunk: string) => {
      logger.info(`[${this._label}] stderr: ${chunk.trimEnd()}`);
    });

    this._child.on('error', (err) => this._fail(err));
    this._child.on('exit', (code, signal) => {
      const msg = `child exited (code=${code}, signal=${signal})`;
      if (!this._closed) logger.warn(`[${this._label}] ${msg}`);
      this._closed = true;
      this._onClose?.();
    });
  }

  // ── McpTransport ───────────────────────────────────────────────────────────

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this._child || this._closed) {
      throw new Error(`[${this._label}] transport not open`);
    }
    const line = JSON.stringify(message) + '\n';
    return new Promise<void>((resolve, reject) => {
      this._child!.stdin.write(line, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
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
    if (!this._child) return;

    try {
      this._child.stdin.end();
    } catch {
      // ignore
    }

    // Graceful shutdown with a short grace period before SIGKILL.
    const child = this._child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private _onStdout(chunk: string): void {
    this._stdoutBuffer += chunk;

    let newlineIdx: number;
    while ((newlineIdx = this._stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this._stdoutBuffer.slice(0, newlineIdx).trim();
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;

      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch {
        logger.warn(`[${this._label}] invalid JSON on stdout: ${line.slice(0, 200)}`);
        continue;
      }
      this._onMessage?.(parsed);
    }
  }

  private _fail(err: Error): void {
    if (this._closed) return;
    this._closed = true;
    this._onError?.(err);
  }
}
