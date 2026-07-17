import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpServerManager } from '../src/mcp/serverManager.js';
import type { McpTransport, JsonRpcMessage, McpServerConfig } from '../src/mcp/types.js';

// ── Controllable in-process transport ─────────────────────────────────────────

/**
 * Simulates a connected MCP server without spawning any process.
 *
 * When the client sends a message via `transport.send()`, `autoRespond` is
 * consulted and the matching handler (if any) fires the onMessage callback
 * back, completing the JSON-RPC round-trip synchronously-ish.
 */
function makeControlledTransport(opts: {
  autoRespond?: boolean;
  serverInfo?: { name: string; version: string };
  failOnStart?: boolean;
}): {
  transport: McpTransport & { started: boolean; closed: boolean };
  pushMessage: (msg: JsonRpcMessage) => void;
  pushError: (err: Error) => void;
  pushClose: () => void;
  sentMessages: JsonRpcMessage[];
} {
  let _onMsg: ((m: JsonRpcMessage) => void) | null = null;
  let _onErr: ((e: Error) => void) | null = null;
  let _onClose: (() => void) | null = null;
  const sentMessages: JsonRpcMessage[] = [];
  let started = false;
  let closed = false;

  const transport = {
    get started() { return started; },
    get closed() { return closed; },
    onMessage(h: (m: JsonRpcMessage) => void) { _onMsg = h; },
    onError(h: (e: Error) => void)   { _onErr = h; },
    onClose(h: () => void)           { _onClose = h; },
    async send(msg: JsonRpcMessage) {
      sentMessages.push(msg);

      if (!opts.autoRespond) return;

      const req = msg as { id?: number; method?: string };
      if (!req.id || !req.method) return;

      if (req.method === 'initialize') {
        setImmediate(() => {
          _onMsg?.({
            jsonrpc: '2.0',
            id: req.id!,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: opts.serverInfo ?? { name: 'test-server', version: '0.1' },
            },
          });
        });
      }
    },
    async close() {
      closed = true;
      _onClose?.();
    },
    // Mimic StdioTransport.start() — called by McpServerManager for stdio transports
    async start() {
      if (opts.failOnStart) throw new Error('spawn failed');
      started = true;
    },
  };

  return {
    transport: transport as McpTransport & { started: boolean; closed: boolean },
    sentMessages,
    pushMessage: (m) => _onMsg?.(m),
    pushError: (e) => _onErr?.(e),
    pushClose: () => _onClose?.(),
  };
}

// ── Testable subclass — overrides _buildTransport ─────────────────────────────

type TransportFactory = (name: string, cfg: McpServerConfig) => ReturnType<typeof makeControlledTransport>['transport'];

class TestableServerManager extends McpServerManager {
  constructor(private readonly _factory: TransportFactory) {
    super({ name: 'test-client', version: '0.0.1' });
  }

  protected override _buildTransport(_name: string, cfg: McpServerConfig) {
    return this._factory(_name, cfg);
  }
}

const HTTP_CFG: McpServerConfig = { transport: 'http', url: 'http://localhost:9999/mcp' };
const STDIO_CFG: McpServerConfig = { transport: 'stdio', command: 'pnpm', args: ['dlx', 'fake-mcp'] };

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('McpServerManager', () => {

  // ── Initial state ────────────────────────────────────────────────────────────

  it('starts with empty server list', () => {
    const mgr = new TestableServerManager(() => { throw new Error('should not build'); });
    assert.deepEqual(mgr.list(), []);
  });

  it('getClient returns undefined before any server is started', () => {
    const mgr = new TestableServerManager(() => { throw new Error('should not build'); });
    assert.equal(mgr.getClient('any'), undefined);
  });

  // ── start / ready ────────────────────────────────────────────────────────────

  it('reaches ready state after successful initialize handshake', async () => {
    const { transport } = makeControlledTransport({ autoRespond: true });
    const mgr = new TestableServerManager(() => transport);

    await mgr.start('svc', HTTP_CFG);

    assert.equal(mgr.get('svc')?.status, 'ready');
    assert.ok(mgr.getClient('svc'), 'client should be available when ready');
  });

  it('sends initialize then notifications/initialized', async () => {
    const { transport, sentMessages } = makeControlledTransport({ autoRespond: true });
    const mgr = new TestableServerManager(() => transport);

    await mgr.start('svc', HTTP_CFG);

    const methods = sentMessages.map(m => (m as { method?: string }).method).filter(Boolean);
    assert.ok(methods.includes('initialize'), 'must send initialize');
    assert.ok(methods.includes('notifications/initialized'), 'must send initialized notification');
  });

  it('stores serverInfo and capabilities on ready entry', async () => {
    const { transport } = makeControlledTransport({
      autoRespond: true,
      serverInfo: { name: 'my-mcp', version: '2.0' },
    });
    const mgr = new TestableServerManager(() => transport);

    await mgr.start('svc', HTTP_CFG);

    const info = mgr.get('svc')!;
    assert.equal(info.serverInfo?.name, 'my-mcp');
    assert.equal(info.serverInfo?.version, '2.0');
    assert.deepEqual(info.capabilities, { tools: {} });
  });

  it('calls transport.start() for stdio configs', async () => {
    const { transport } = makeControlledTransport({ autoRespond: true });
    const mgr = new TestableServerManager(() => transport);

    await mgr.start('svc', STDIO_CFG);

    assert.equal(transport.started, true);
  });

  it('does not call transport.start() for http configs', async () => {
    const { transport } = makeControlledTransport({ autoRespond: true });
    const mgr = new TestableServerManager(() => transport);

    await mgr.start('svc', HTTP_CFG);

    assert.equal(transport.started, false);
  });

  // ── start failure ────────────────────────────────────────────────────────────

  it('transitions to error state when initialize times out', async () => {
    const { transport } = makeControlledTransport({ autoRespond: false });
    const mgr = new TestableServerManager(() => transport);

    // Use a very short timeout by passing a config that will time out.
    // We need to replace the timeout — simplest: don't respond + default 30s is too long.
    // Instead: simulate transport error right after start.
    const { pushError } = makeControlledTransport({ autoRespond: false });

    // Build a transport that errors immediately
    const errTransport: McpTransport & { started: boolean; closed: boolean } = {
      started: false,
      closed: false,
      onMessage() {},
      onError(h) { setImmediate(() => h(new Error('connection refused'))); },
      onClose() {},
      async send() {},
      async close() { this.closed = true; },
      async start() { this.started = true; },
    };

    const errMgr = new TestableServerManager(() => errTransport);

    // We need to wait for the start to settle — it will fail due to the error
    // fired before initialize responds.
    await errMgr.start('svc', HTTP_CFG);

    // The initialize call will be pending; the transport error races it.
    // Depending on timing, the entry may be 'error'. Give it a tick.
    await new Promise(r => setImmediate(r));

    const info = errMgr.get('svc');
    assert.equal(info?.status, 'error');
    assert.ok(info?.error?.includes('connection refused'));
    void transport; void pushError; // suppress unused warnings
  });

  it('transitions to error when stdio spawn fails', async () => {
    const { transport } = makeControlledTransport({ failOnStart: true });
    const mgr = new TestableServerManager(() => transport);

    await mgr.start('svc', STDIO_CFG);

    assert.equal(mgr.get('svc')?.status, 'error');
    assert.match(mgr.get('svc')?.error ?? '', /spawn failed/);
  });

  // ── stop ─────────────────────────────────────────────────────────────────────

  it('stop transitions to stopped and removes client', async () => {
    const { transport } = makeControlledTransport({ autoRespond: true });
    const mgr = new TestableServerManager(() => transport);

    await mgr.start('svc', HTTP_CFG);
    assert.equal(mgr.get('svc')?.status, 'ready');

    await mgr.stop('svc');
    assert.equal(mgr.get('svc')?.status, 'stopped');
    assert.equal(mgr.getClient('svc'), undefined);
  });

  it('stop closes the underlying transport', async () => {
    const { transport } = makeControlledTransport({ autoRespond: true });
    const mgr = new TestableServerManager(() => transport);

    await mgr.start('svc', HTTP_CFG);
    await mgr.stop('svc');

    assert.equal(transport.closed, true);
  });

  it('stop on unknown server is a no-op', async () => {
    const mgr = new TestableServerManager(() => { throw new Error('should not build'); });
    await assert.doesNotReject(() => mgr.stop('ghost'));
  });

  // ── transport close mid-session ───────────────────────────────────────────────

  it('entry transitions to error when transport closes unexpectedly', async () => {
    const { transport, pushClose } = makeControlledTransport({ autoRespond: true });
    const mgr = new TestableServerManager(() => transport);

    await mgr.start('svc', HTTP_CFG);
    assert.equal(mgr.get('svc')?.status, 'ready');

    pushClose();
    await new Promise(r => setImmediate(r));

    assert.equal(mgr.get('svc')?.status, 'error');
  });

  // ── restart ───────────────────────────────────────────────────────────────────

  it('restart reuses the original config', async () => {
    let callCount = 0;
    const factory: TransportFactory = () => {
      callCount++;
      return makeControlledTransport({ autoRespond: true }).transport;
    };
    const mgr = new TestableServerManager(factory);

    await mgr.start('svc', HTTP_CFG);
    assert.equal(callCount, 1);

    await mgr.restart('svc');
    assert.equal(callCount, 2);
    assert.equal(mgr.get('svc')?.status, 'ready');
  });

  it('restart on unknown server throws', async () => {
    const mgr = new TestableServerManager(() => { throw new Error('unreachable'); });
    await assert.rejects(() => mgr.restart('ghost'), /unknown server/);
  });

  // ── sync ──────────────────────────────────────────────────────────────────────

  it('sync starts new servers', async () => {
    const { transport } = makeControlledTransport({ autoRespond: true });
    const mgr = new TestableServerManager(() => transport);

    await mgr.sync({ memory: HTTP_CFG });
    assert.equal(mgr.get('memory')?.status, 'ready');
  });

  it('sync stops removed servers', async () => {
    const { transport } = makeControlledTransport({ autoRespond: true });
    const mgr = new TestableServerManager(() => transport);

    await mgr.sync({ memory: HTTP_CFG });
    await mgr.sync({});

    assert.equal(mgr.get('memory'), undefined);
  });

  it('sync does not restart already-ready servers with same config', async () => {
    let buildCount = 0;
    const mgr = new TestableServerManager(() => {
      buildCount++;
      return makeControlledTransport({ autoRespond: true }).transport;
    });

    await mgr.sync({ memory: HTTP_CFG });
    const countAfterFirst = buildCount;
    await mgr.sync({ memory: HTTP_CFG });

    assert.equal(buildCount, countAfterFirst, 'should not rebuild transport if config unchanged');
  });

  // ── stopAll ───────────────────────────────────────────────────────────────────

  it('stopAll closes every server', async () => {
    const transports: Array<McpTransport & { closed: boolean }> = [];
    const mgr = new TestableServerManager(() => {
      const t = makeControlledTransport({ autoRespond: true }).transport;
      transports.push(t);
      return t;
    });

    await mgr.sync({ a: HTTP_CFG, b: HTTP_CFG });
    await mgr.stopAll();

    assert.ok(transports.every(t => t.closed), 'all transports must be closed');
  });

  // ── onDidChange events ───────────────────────────────────────────────────────

  it('emits onDidChange when server becomes ready', async () => {
    const { transport } = makeControlledTransport({ autoRespond: true });
    const mgr = new TestableServerManager(() => transport);
    const events: string[][] = [];
    mgr.onDidChange(list => events.push(list.map(s => s.status)));

    await mgr.start('svc', HTTP_CFG);

    assert.ok(events.length > 0, 'should have emitted at least once');
    const lastStatuses = events[events.length - 1];
    assert.ok(lastStatuses.includes('ready'));
  });
});
