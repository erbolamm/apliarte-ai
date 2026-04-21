import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcClient } from '../src/mcp/jsonrpc.js';
import type { McpTransport, JsonRpcMessage } from '../src/mcp/types.js';

// ── In-memory transport stub ───────────────────────────────────────────────

function makeTransport(): {
  transport: McpTransport;
  send: (msg: JsonRpcMessage) => void;
  simulateClose: () => void;
  simulateError: (err: Error) => void;
  sent: JsonRpcMessage[];
} {
  let _onMsg: ((m: JsonRpcMessage) => void) | null = null;
  let _onErr: ((e: Error) => void) | null = null;
  let _onClose: (() => void) | null = null;
  const sent: JsonRpcMessage[] = [];

  const transport: McpTransport = {
    onMessage(h) { _onMsg = h; },
    onError(h)   { _onErr = h; },
    onClose(h)   { _onClose = h; },
    async send(msg) { sent.push(msg); },
    async close() { _onClose?.(); },
  };

  return {
    transport,
    sent,
    send: (msg) => _onMsg?.(msg),
    simulateClose: () => _onClose?.(),
    simulateError: (err) => _onErr?.(err),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('JsonRpcClient', () => {
  it('sends a request with incrementing id', async () => {
    const { transport, send, sent } = makeTransport();
    const client = new JsonRpcClient(transport, { label: 'test' });

    const promise = client.request('tools/list');

    // Simulate server response
    const req = sent[0] as { id: number };
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [] } });

    const result = await promise as { tools: unknown[] };
    assert.deepEqual(result, { tools: [] });
    assert.equal((sent[0] as { method: string }).method, 'tools/list');
  });

  it('assigns sequential ids', async () => {
    const { transport, send, sent } = makeTransport();
    const client = new JsonRpcClient(transport, { label: 'test' });

    const p1 = client.request('method/a');
    const p2 = client.request('method/b');

    const id1 = (sent[0] as { id: number }).id;
    const id2 = (sent[1] as { id: number }).id;
    assert.equal(id2, id1 + 1);

    send({ jsonrpc: '2.0', id: id1, result: 'a' });
    send({ jsonrpc: '2.0', id: id2, result: 'b' });

    assert.equal(await p1, 'a');
    assert.equal(await p2, 'b');
  });

  it('rejects on JSON-RPC error response', async () => {
    const { transport, send, sent } = makeTransport();
    const client = new JsonRpcClient(transport, { label: 'test' });

    const promise = client.request('tools/call');
    const id = (sent[0] as { id: number }).id;
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });

    await assert.rejects(promise, /Method not found/);
  });

  it('rejects on timeout', async () => {
    const { transport } = makeTransport();
    const client = new JsonRpcClient(transport, { defaultTimeoutMs: 10, label: 'test' });

    await assert.rejects(
      client.request('slow/method'),
      /timed out/,
    );
  });

  it('rejects after close', async () => {
    const { transport } = makeTransport();
    const client = new JsonRpcClient(transport);
    await client.close();

    await assert.rejects(client.request('any'), /client closed/);
  });

  it('fails pending requests on transport close', async () => {
    const { transport, simulateClose } = makeTransport();
    const client = new JsonRpcClient(transport, { label: 'test' });

    const promise = client.request('pending/method', undefined, 5000);
    simulateClose();

    await assert.rejects(promise, /transport closed/);
  });

  it('fails pending requests on transport error', async () => {
    const { transport, simulateError } = makeTransport();
    const client = new JsonRpcClient(transport, { label: 'test' });

    const promise = client.request('pending/method', undefined, 5000);
    simulateError(new Error('ECONNRESET'));

    await assert.rejects(promise, /ECONNRESET/);
  });

  it('sends notification without expecting response', async () => {
    const { transport, sent } = makeTransport();
    const client = new JsonRpcClient(transport, { label: 'test' });

    await client.notify('notifications/initialized', { version: '1.0' });

    assert.equal(sent.length, 1);
    const note = sent[0] as { method: string; id?: unknown };
    assert.equal(note.method, 'notifications/initialized');
    assert.equal(note.id, undefined);
  });
});
