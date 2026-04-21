/**
 * MCP server manager — lifecycle for multiple MCP servers.
 *
 * Holds one entry per configured server, each with:
 *   - the right transport (stdio or HTTP) based on config
 *   - a JsonRpcClient on top of it
 *   - the MCP initialize handshake completed
 *   - a status (stopped | starting | ready | error)
 *
 * Emits change events so the UI can show per-server indicators.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { JsonRpcClient } from './jsonrpc';
import { HttpTransport } from './transport-http';
import { StdioTransport } from './transport-stdio';
import { McpServerConfig, McpTransport } from './types';

// Baseline MCP protocol version. Servers may negotiate down in their response.
const MCP_PROTOCOL_VERSION = '2024-11-05';

export type McpServerStatus = 'stopped' | 'starting' | 'ready' | 'error';

export interface McpServerInfo {
  name: string;
  status: McpServerStatus;
  error?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

interface InitializeResult {
  protocolVersion: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
}

interface ServerEntry extends McpServerInfo {
  config: McpServerConfig;
  transport?: McpTransport;
  client?: JsonRpcClient;
}

interface ClientMeta {
  name: string;
  version: string;
}

export class McpServerManager {
  private readonly _entries = new Map<string, ServerEntry>();
  private readonly _emitter = new vscode.EventEmitter<McpServerInfo[]>();
  private readonly _clientMeta: ClientMeta;

  readonly onDidChange = this._emitter.event;

  constructor(clientMeta: ClientMeta) {
    this._clientMeta = clientMeta;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  list(): McpServerInfo[] {
    return [...this._entries.values()].map((e) => this._snapshot(e));
  }

  get(name: string): McpServerInfo | undefined {
    const e = this._entries.get(name);
    return e ? this._snapshot(e) : undefined;
  }

  /** Get the live JSON-RPC client for a ready server, or undefined. */
  getClient(name: string): JsonRpcClient | undefined {
    const e = this._entries.get(name);
    return e?.status === 'ready' ? e.client : undefined;
  }

  /** Start or restart a single server. Stops any existing instance first. */
  async start(name: string, config: McpServerConfig): Promise<void> {
    await this.stop(name);

    const entry: ServerEntry = { name, config, status: 'starting' };
    this._entries.set(name, entry);
    this._emit();

    try {
      entry.transport = this._buildTransport(name, config);
      entry.client = new JsonRpcClient(entry.transport, { label: name });

      if (config.transport === 'stdio' && 'start' in entry.transport) {
        await (entry.transport as { start(): Promise<void> }).start();
      }

      const init = await entry.client.request<InitializeResult>('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this._clientMeta,
      });

      await entry.client.notify('notifications/initialized');

      entry.client.onClose((reason) => {
        const current = this._entries.get(name);
        if (!current || current.status === 'stopped') return;
        current.status = 'error';
        current.error = reason.message;
        logger.warn(`[mcp:${name}] connection lost: ${reason.message}`);
        this._emit();
      });

      entry.status = 'ready';
      entry.serverInfo = init.serverInfo;
      entry.capabilities = init.capabilities;
      entry.error = undefined;
      logger.info(`[mcp:${name}] ready (${init.serverInfo?.name ?? '?'} ${init.serverInfo?.version ?? ''})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.status = 'error';
      entry.error = msg;
      logger.warn(`[mcp:${name}] failed to start: ${msg}`);
      try { await entry.client?.close(); } catch { /* ignore */ }
    } finally {
      this._emit();
    }
  }

  async stop(name: string): Promise<void> {
    const entry = this._entries.get(name);
    if (!entry) return;

    if (entry.client) {
      try { await entry.client.close(); } catch (err) {
        logger.warn(`[mcp:${name}] close error: ${(err as Error).message}`);
      }
    }
    entry.client = undefined;
    entry.transport = undefined;
    entry.status = 'stopped';
    this._emit();
  }

  async restart(name: string): Promise<void> {
    const entry = this._entries.get(name);
    if (!entry) throw new Error(`[mcp] unknown server: ${name}`);
    await this.start(name, entry.config);
  }

  /** Sync the manager with the current config map. Starts new, stops removed, restarts changed. */
  async sync(configs: Record<string, McpServerConfig>): Promise<void> {
    const names = new Set(Object.keys(configs));

    // Stop servers no longer in config.
    for (const existing of this._entries.keys()) {
      if (!names.has(existing)) {
        await this.stop(existing);
        this._entries.delete(existing);
      }
    }

    // Start or restart the rest.
    await Promise.all(
      Object.entries(configs).map(async ([name, cfg]) => {
        const prev = this._entries.get(name);
        if (prev && this._sameConfig(prev.config, cfg) && prev.status === 'ready') return;
        await this.start(name, cfg);
      }),
    );

    this._emit();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this._entries.keys()].map((n) => this.stop(n)));
  }

  dispose(): void {
    // Fire-and-forget shutdown; the extension host is closing anyway.
    void this.stopAll();
    this._emitter.dispose();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  protected _buildTransport(name: string, config: McpServerConfig): McpTransport {
    switch (config.transport) {
      case 'stdio':
        return new StdioTransport(config, `mcp:${name}`);
      case 'http':
        return new HttpTransport(config, `mcp:${name}`);
      default: {
        const exhaustive: never = config;
        throw new Error(`[mcp:${name}] unknown transport: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private _sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private _snapshot(e: ServerEntry): McpServerInfo {
    return {
      name: e.name,
      status: e.status,
      error: e.error,
      serverInfo: e.serverInfo,
      capabilities: e.capabilities,
    };
  }

  private _emit(): void {
    this._emitter.fire(this.list());
  }
}
