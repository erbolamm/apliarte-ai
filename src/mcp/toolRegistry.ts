/**
 * Unified tool registry.
 *
 * Merges:
 *   - Built-in tools (readFile, writeFile, …) registered by the extension itself.
 *   - MCP tools discovered dynamically via `tools/list` on each connected server.
 *
 * MCP tools are namespaced as `{server}.{toolName}` to avoid collisions across
 * servers (e.g. `engram.mem_save` vs `github.mem_save`). Built-ins keep their
 * plain name.
 *
 * `execute()` routes the call to the right handler: direct function for
 * built-ins, `tools/call` JSON-RPC for MCP tools.
 */

import { logger } from '../utils/logger';
import type { McpServerManager } from './serverManager';
import type { McpTool, McpToolCallResult } from './types';

export type BuiltinHandler = (args: Record<string, unknown>) => Promise<string>;

export interface BuiltinSource { kind: 'builtin'; }
export interface McpSource {
  kind: 'mcp';
  server: string;
  originalName: string;
}
export type ToolSource = BuiltinSource | McpSource;

export interface ToolDescriptor {
  name: string;              // externally visible (namespaced for MCP)
  description?: string;
  inputSchema: unknown;      // JSON Schema
  source: ToolSource;
}

export class ToolRegistry {
  private readonly _tools = new Map<string, ToolDescriptor>();
  private readonly _builtinHandlers = new Map<string, BuiltinHandler>();
  private _serverMgr?: McpServerManager;

  // ── Wiring ────────────────────────────────────────────────────────────────

  setServerManager(mgr: McpServerManager): void {
    this._serverMgr = mgr;
  }

  getServerManager(): McpServerManager | undefined {
    return this._serverMgr;
  }

  // ── Registration ──────────────────────────────────────────────────────────

  registerBuiltin(
    name: string,
    spec: { description?: string; inputSchema: unknown },
    handler: BuiltinHandler,
  ): void {
    if (this._tools.has(name)) {
      logger.warn(`[toolRegistry] builtin collision: ${name}, overwriting`);
    }
    this._tools.set(name, {
      name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      source: { kind: 'builtin' },
    });
    this._builtinHandlers.set(name, handler);
  }

  unregisterServer(serverName: string): void {
    for (const [key, tool] of this._tools) {
      if (tool.source.kind === 'mcp' && tool.source.server === serverName) {
        this._tools.delete(key);
      }
    }
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  /** Call `tools/list` on a single server and register its tools. Returns count. */
  async discoverFromServer(serverName: string): Promise<number> {
    const client = this._serverMgr?.getClient(serverName);
    if (!client) {
      logger.warn(`[toolRegistry] cannot discover: server not ready: ${serverName}`);
      return 0;
    }

    this.unregisterServer(serverName);

    const res = await client.request<{ tools?: McpTool[] }>('tools/list');
    let count = 0;
    for (const tool of res.tools ?? []) {
      const namespaced = `${serverName}.${tool.name}`;
      if (this._tools.has(namespaced)) {
        logger.warn(`[toolRegistry] collision on ${namespaced}, overwriting`);
      }
      this._tools.set(namespaced, {
        name: namespaced,
        description: tool.description,
        inputSchema: tool.inputSchema,
        source: { kind: 'mcp', server: serverName, originalName: tool.name },
      });
      count++;
    }
    logger.info(`[toolRegistry] discovered ${count} tool(s) from ${serverName}`);
    return count;
  }

  /** Call `tools/list` on every ready server. */
  async discoverAll(): Promise<void> {
    const mgr = this._serverMgr;
    if (!mgr) return;

    const ready = mgr.list().filter((s) => s.status === 'ready').map((s) => s.name);
    await Promise.all(
      ready.map((name) =>
        this.discoverFromServer(name).catch((err) => {
          logger.warn(`[toolRegistry] tools/list failed for ${name}: ${(err as Error).message}`);
          return 0;
        }),
      ),
    );
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  list(): ToolDescriptor[] {
    return [...this._tools.values()];
  }

  get(name: string): ToolDescriptor | undefined {
    return this._tools.get(name);
  }

  has(name: string): boolean {
    return this._tools.has(name);
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  async execute(name: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<string> {
    const descriptor = this._tools.get(name);
    if (!descriptor) throw new Error(`Unknown tool: ${name}`);

    const withTimeout = <T>(promise: Promise<T>): Promise<T> => {
      const timer = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool timeout after ${timeoutMs / 1000}s: ${name}`)), timeoutMs),
      );
      return Promise.race([promise, timer]);
    };

    if (descriptor.source.kind === 'builtin') {
      const handler = this._builtinHandlers.get(name);
      if (!handler) throw new Error(`No handler registered for builtin: ${name}`);
      return withTimeout(handler(args));
    }

    const { server, originalName } = descriptor.source;
    const client = this._serverMgr?.getClient(server);
    if (!client) throw new Error(`MCP server not ready: ${server}`);

    const result = await withTimeout(client.request<McpToolCallResult>('tools/call', {
      name: originalName,
      arguments: args,
    }));
    return this._formatMcpResult(result);
  }

  private _formatMcpResult(result: McpToolCallResult): string {
    const text = (result.content ?? [])
      .map((c) => {
        if (c.type === 'text') return c.text ?? '';
        if (c.type === 'image') return `[image ${c.mimeType ?? ''}]`;
        if (c.type === 'resource') return `[resource ${c.mimeType ?? ''}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return result.isError ? `Error: ${text}` : text;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: ToolRegistry | undefined;

export function getToolRegistry(): ToolRegistry {
  if (!_instance) _instance = new ToolRegistry();
  return _instance;
}
