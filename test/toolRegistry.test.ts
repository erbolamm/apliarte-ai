import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/mcp/toolRegistry.js';
import type { McpServerManager } from '../src/mcp/serverManager.js';

// ── Minimal McpServerManager stub ─────────────────────────────────────────────

function makeServerManager(servers: {
  name: string;
  status: 'ready' | 'error' | 'connecting';
  tools?: { name: string; description?: string; inputSchema: unknown }[];
}[]): McpServerManager {
  const clients = new Map(servers.map(s => [s.name, {
    request: async (method: string) => {
      if (method === 'tools/list') {
        return { tools: s.tools ?? [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  }]));

  return {
    list: () => servers.map(s => ({ name: s.name, status: s.status })),
    getClient: (name: string) => clients.get(name) as never,
    // unused methods — satisfy the type with minimal stubs
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    stopAll: async () => {},
    getStatus: (name: string) => servers.find(s => s.name === name)?.status ?? 'error',
    onStatusChange: () => ({ dispose: () => {} }),
  } as unknown as McpServerManager;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {

  // ── Registration ────────────────────────────────────────────────────────────

  it('registers a builtin and lists it', () => {
    const r = new ToolRegistry();
    r.registerBuiltin('greet', { description: 'Greet', inputSchema: {} }, async () => 'hello');

    assert.ok(r.has('greet'));
    const tools = r.list();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'greet');
    assert.equal(tools[0].source.kind, 'builtin');
  });

  it('executes a builtin handler', async () => {
    const r = new ToolRegistry();
    r.registerBuiltin('echo', { inputSchema: {} }, async (args) => String(args.msg));

    const result = await r.execute('echo', { msg: 'world' });
    assert.equal(result, 'world');
  });

  it('overwrites on builtin name collision', () => {
    const r = new ToolRegistry();
    r.registerBuiltin('dupe', { inputSchema: {} }, async () => 'first');
    r.registerBuiltin('dupe', { inputSchema: {} }, async () => 'second');

    assert.equal(r.list().length, 1);
  });

  it('executes the new handler after overwrite', async () => {
    const r = new ToolRegistry();
    r.registerBuiltin('dupe', { inputSchema: {} }, async () => 'first');
    r.registerBuiltin('dupe', { inputSchema: {} }, async () => 'second');

    const result = await r.execute('dupe', {});
    assert.equal(result, 'second');
  });

  // ── Tool not found ──────────────────────────────────────────────────────────

  it('throws on unknown tool', async () => {
    const r = new ToolRegistry();
    await assert.rejects(r.execute('ghost', {}), /Unknown tool: ghost/);
  });

  // ── Builtin vs MCP dispatch ─────────────────────────────────────────────────

  it('dispatches MCP tool via tools/call', async () => {
    const r = new ToolRegistry();
    let capturedArgs: unknown;

    const mgr = {
      list: () => [{ name: 'fs', status: 'ready' as const }],
      getClient: () => ({
        request: async (method: string, params: unknown) => {
          capturedArgs = params;
          if (method === 'tools/call') {
            return { content: [{ type: 'text', text: 'read-ok' }], isError: false };
          }
          return { tools: [{ name: 'read_file', inputSchema: {} }] };
        },
      }),
    } as unknown as McpServerManager;

    r.setServerManager(mgr);
    await r.discoverFromServer('fs');
    const result = await r.execute('fs.read_file', { path: 'foo.ts' });

    assert.equal(result, 'read-ok');
    assert.deepEqual((capturedArgs as { name: string }).name, 'read_file');
  });

  it('builtin is not routed through MCP', async () => {
    const r = new ToolRegistry();
    let mcpCalled = false;

    const mgr = {
      list: () => [],
      getClient: () => {
        mcpCalled = true;
        return undefined;
      },
    } as unknown as McpServerManager;

    r.setServerManager(mgr);
    r.registerBuiltin('local', { inputSchema: {} }, async () => 'local-result');

    const result = await r.execute('local', {});
    assert.equal(result, 'local-result');
    assert.equal(mcpCalled, false);
  });

  // ── Discovery ───────────────────────────────────────────────────────────────

  it('discovers tools from server with namespace prefix', async () => {
    const r = new ToolRegistry();
    const mgr = makeServerManager([{
      name: 'memory',
      status: 'ready',
      tools: [
        { name: 'mem_save', inputSchema: { type: 'object' } },
        { name: 'mem_search', inputSchema: { type: 'object' } },
      ],
    }]);

    r.setServerManager(mgr);
    const count = await r.discoverFromServer('memory');

    assert.equal(count, 2);
    assert.ok(r.has('memory.mem_save'));
    assert.ok(r.has('memory.mem_search'));
    assert.equal(r.get('memory.mem_save')?.source.kind, 'mcp');
  });

  it('does not register builtin-named tool under builtin namespace', async () => {
    const r = new ToolRegistry();
    r.registerBuiltin('readFile', { inputSchema: {} }, async () => 'builtin');

    const mgr = makeServerManager([{
      name: 'fs',
      status: 'ready',
      tools: [{ name: 'readFile', inputSchema: {} }],
    }]);

    r.setServerManager(mgr);
    await r.discoverFromServer('fs');

    // builtin 'readFile' stays; MCP tool is 'fs.readFile'
    assert.equal(r.get('readFile')?.source.kind, 'builtin');
    assert.equal(r.get('fs.readFile')?.source.kind, 'mcp');
  });

  it('discoverAll only queries ready servers', async () => {
    const r = new ToolRegistry();
    const queried: string[] = [];

    const mgr = {
      list: () => [
        { name: 'ready-server', status: 'ready' as const },
        { name: 'error-server', status: 'error' as const },
      ],
      getClient: (name: string) => {
        queried.push(name);
        return {
          request: async () => ({ tools: [] }),
        };
      },
    } as unknown as McpServerManager;

    r.setServerManager(mgr);
    await r.discoverAll();

    assert.deepEqual(queried, ['ready-server']);
  });

  // ── Unregister ──────────────────────────────────────────────────────────────

  it('unregisterServer removes its tools but not builtins', async () => {
    const r = new ToolRegistry();
    r.registerBuiltin('local', { inputSchema: {} }, async () => 'ok');

    const mgr = makeServerManager([{
      name: 'svc',
      status: 'ready',
      tools: [{ name: 'do_thing', inputSchema: {} }],
    }]);

    r.setServerManager(mgr);
    await r.discoverFromServer('svc');

    assert.ok(r.has('svc.do_thing'));
    r.unregisterServer('svc');

    assert.equal(r.has('svc.do_thing'), false);
    assert.ok(r.has('local'));
  });

  // ── MCP result formatting ───────────────────────────────────────────────────

  it('formats MCP isError result with Error prefix', async () => {
    const r = new ToolRegistry();

    const mgr = {
      list: () => [{ name: 'srv', status: 'ready' as const }],
      getClient: () => ({
        request: async (method: string) => {
          if (method === 'tools/list') return { tools: [{ name: 'fail', inputSchema: {} }] };
          return { content: [{ type: 'text', text: 'something went wrong' }], isError: true };
        },
      }),
    } as unknown as McpServerManager;

    r.setServerManager(mgr);
    await r.discoverFromServer('srv');

    const result = await r.execute('srv.fail', {});
    assert.match(result, /^Error: something went wrong/);
  });
});
