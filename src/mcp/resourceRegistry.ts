/**
 * MCP Resource and Prompt registry.
 *
 * Resources: static content that can be attached as context to the LLM
 *   (docs, files, DB rows exposed by the server).
 * Prompts: predefined prompt templates that servers expose as quick actions.
 *
 * Both are discovered via `resources/list` and `prompts/list` on each
 * connected server, stored with `{server}.{name}` namespace.
 */

import { logger } from '../utils/logger';
import type { McpServerManager } from './serverManager';

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  server: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  server: string;
}

export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

export class McpResourceRegistry {
  private _resources: McpResource[] = [];
  private _prompts: McpPrompt[] = [];
  private _serverMgr?: McpServerManager;

  setServerManager(mgr: McpServerManager): void {
    this._serverMgr = mgr;
  }

  // ── Resources ─────────────────────────────────────────────────────────────

  async discoverResourcesFromServer(serverName: string): Promise<number> {
    const client = this._serverMgr?.getClient(serverName);
    if (!client) return 0;

    this._resources = this._resources.filter((r) => r.server !== serverName);

    try {
      const res = await client.request<{ resources?: Array<{ uri: string; name: string; description?: string; mimeType?: string }> }>('resources/list');
      for (const r of res.resources ?? []) {
        this._resources.push({ ...r, server: serverName });
      }
      logger.info(`[resourceRegistry] discovered ${res.resources?.length ?? 0} resource(s) from ${serverName}`);
      return res.resources?.length ?? 0;
    } catch {
      // Server may not support resources — not an error
      return 0;
    }
  }

  async readResource(serverName: string, uri: string): Promise<McpResourceContent[]> {
    const client = this._serverMgr?.getClient(serverName);
    if (!client) throw new Error(`MCP server not ready: ${serverName}`);

    const res = await client.request<{ contents?: McpResourceContent[] }>('resources/read', { uri });
    return res.contents ?? [];
  }

  listResources(): McpResource[] {
    return [...this._resources];
  }

  // ── Prompts ───────────────────────────────────────────────────────────────

  async discoverPromptsFromServer(serverName: string): Promise<number> {
    const client = this._serverMgr?.getClient(serverName);
    if (!client) return 0;

    this._prompts = this._prompts.filter((p) => p.server !== serverName);

    try {
      const res = await client.request<{
        prompts?: Array<{
          name: string;
          description?: string;
          arguments?: Array<{ name: string; description?: string; required?: boolean }>;
        }>;
      }>('prompts/list');
      for (const p of res.prompts ?? []) {
        this._prompts.push({ ...p, server: serverName });
      }
      logger.info(`[resourceRegistry] discovered ${res.prompts?.length ?? 0} prompt(s) from ${serverName}`);
      return res.prompts?.length ?? 0;
    } catch {
      return 0;
    }
  }

  async getPrompt(serverName: string, promptName: string, args?: Record<string, string>): Promise<McpPromptResult> {
    const client = this._serverMgr?.getClient(serverName);
    if (!client) throw new Error(`MCP server not ready: ${serverName}`);

    const res = await client.request<McpPromptResult>('prompts/get', {
      name: promptName,
      arguments: args ?? {},
    });
    return res;
  }

  listPrompts(): McpPrompt[] {
    return [...this._prompts];
  }

  // ── Discover all ──────────────────────────────────────────────────────────

  async discoverAll(): Promise<void> {
    const mgr = this._serverMgr;
    if (!mgr) return;

    const ready = mgr.list().filter((s) => s.status === 'ready').map((s) => s.name);
    await Promise.all(
      ready.flatMap((name) => [
        this.discoverResourcesFromServer(name).catch(() => 0),
        this.discoverPromptsFromServer(name).catch(() => 0),
      ]),
    );
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: McpResourceRegistry | undefined;

export function getMcpResourceRegistry(): McpResourceRegistry {
  if (!_instance) _instance = new McpResourceRegistry();
  return _instance;
}
