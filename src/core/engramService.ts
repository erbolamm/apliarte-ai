import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EngramMemory {
  id: number;
  title: string;
  content: string;
  type: string;
  project?: string;
  created_at?: string;
}

export interface EngramSearchResult {
  id: number;
  title: string;
  content: string;          // may be truncated
  score?: number;
  type?: string;
}

// ── EngramService ────────────────────────────────────────────────────────────

/**
 * Connects to the Engram MCP server via HTTP (SSE endpoint).
 * Falls back gracefully when Engram is not running.
 *
 * Engram exposes an HTTP endpoint by default at http://localhost:4200
 * (configured in the user's claude_desktop_config.json).
 * We talk to it via direct HTTP calls to avoid bundling the full MCP SDK.
 */
export class EngramService {
  private _baseUrl: string;
  private _available = false;
  private _checked  = false;

  constructor() {
    this._baseUrl = vscode.workspace
      .getConfiguration('apliarteAi')
      .get<string>('engramEndpoint', 'http://localhost:4200');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    if (this._checked) return this._available;
    this._checked = true;
    try {
      const res = await fetch(`${this._baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      this._available = res.ok;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  async search(query: string, project?: string, limit = 10): Promise<EngramSearchResult[]> {
    if (!(await this.isAvailable())) return [];
    try {
      const params = new URLSearchParams({ query, limit: String(limit) });
      if (project) params.set('project', project);
      const res = await fetch(`${this._baseUrl}/search?${params}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { results?: EngramSearchResult[] };
      return data.results ?? [];
    } catch (err) {
      logger.warn(`Engram search failed: ${err}`);
      return [];
    }
  }

  async save(params: {
    title: string;
    content: string;
    type?: string;
    project?: string;
    topic_key?: string;
  }): Promise<number | undefined> {
    if (!(await this.isAvailable())) return undefined;
    try {
      const res = await fetch(`${this._baseUrl}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return undefined;
      const data = await res.json() as { id?: number };
      return data.id;
    } catch (err) {
      logger.warn(`Engram save failed: ${err}`);
      return undefined;
    }
  }

  async getObservation(id: number): Promise<EngramMemory | undefined> {
    if (!(await this.isAvailable())) return undefined;
    try {
      const res = await fetch(`${this._baseUrl}/observation/${id}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return undefined;
      return await res.json() as EngramMemory;
    } catch {
      return undefined;
    }
  }

  async getContext(project?: string, limit = 20): Promise<EngramSearchResult[]> {
    if (!(await this.isAvailable())) return [];
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (project) params.set('project', project);
      const res = await fetch(`${this._baseUrl}/context?${params}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { observations?: EngramSearchResult[] };
      return data.observations ?? [];
    } catch {
      return [];
    }
  }

  /** Detect if Engram MCP server is reachable via stdio by checking npx */
  static async detectEngramPath(): Promise<string | undefined> {
    // Common locations for the engram binary
    const candidates = [
      'engram-mcp',
      path.join(process.env.HOME ?? '', '.npm-global', 'bin', 'engram-mcp'),
      path.join(process.env.HOME ?? '', '.local', 'bin', 'engram-mcp'),
    ];
    return candidates[0]; // Return first candidate for now
  }

  /** Reset availability check (useful when user changes endpoint in settings) */
  reset(): void {
    this._checked = false;
    this._available = false;
    this._baseUrl = vscode.workspace
      .getConfiguration('apliarteAi')
      .get<string>('engramEndpoint', 'http://localhost:4200');
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: EngramService | undefined;

export function getEngramService(): EngramService {
  if (!_instance) _instance = new EngramService();
  return _instance;
}

export function resetEngramService(): void {
  _instance?.reset();
}
