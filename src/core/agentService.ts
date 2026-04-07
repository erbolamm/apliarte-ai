import { logger } from '../utils/logger';
import type { ChatMessage, StreamOptions } from './llmService';

/**
 * Agent service — connects to the ApliArte Code Agent backend on VPS.
 * Handles streaming chat with tool-calling protocol.
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentEvent {
  type: 'chunk' | 'tool_call' | 'done' | 'error';
  text?: string;
  toolCall?: ToolCall;
}

export async function* streamAgentChat(
  endpoint: string,
  apiKey: string,
  messages: ChatMessage[],
  options?: StreamOptions & { workspaceId?: string; toolsEnabled?: boolean }
): AsyncGenerator<AgentEvent> {
  const url = `${endpoint}/v1/chat`;
  const controller = new AbortController();

  if (options?.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const body = {
    messages,
    workspace_id: options?.workspaceId ?? null,
    tools_enabled: options?.toolsEnabled ?? true,
    model: options?.model ?? null,
    temperature: options?.temperature ?? 0.7,
  };

  logger.info(`Agent request → ${url} (${messages.length} msgs)`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    yield { type: 'error', text: `Cannot connect to agent at ${endpoint}` };
    return;
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errBody = await response.text();
      if (errBody) detail = errBody.slice(0, 200);
    } catch { /* ignore */ }
    yield { type: 'error', text: `Agent error ${response.status}: ${detail}` };
    return;
  }

  if (!response.body) {
    yield { type: 'error', text: 'No response body from agent' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let eventType = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          eventType = '';
          continue;
        }
        if (trimmed.startsWith('event: ')) {
          eventType = trimmed.slice(7);
          continue;
        }
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6);
          try {
            const data = JSON.parse(dataStr);
            switch (eventType) {
              case 'chunk':
                yield { type: 'chunk', text: data.text };
                break;
              case 'tool_call':
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: data.id,
                    name: data.name,
                    arguments: data.arguments,
                  },
                };
                break;
              case 'done':
                yield { type: 'done' };
                break;
              case 'error':
                yield { type: 'error', text: data.text };
                break;
            }
          } catch {
            // malformed JSON, skip
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Send tool results back and continue the conversation.
 */
export async function* continueAfterToolCall(
  endpoint: string,
  apiKey: string,
  messages: ChatMessage[],
  options?: StreamOptions & { workspaceId?: string }
): AsyncGenerator<AgentEvent> {
  const url = `${endpoint}/v1/tool-result`;
  const controller = new AbortController();

  if (options?.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const body = {
    messages,
    workspace_id: options?.workspaceId ?? null,
    model: options?.model ?? null,
    temperature: options?.temperature ?? 0.7,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    yield { type: 'error', text: `Cannot connect to agent at ${endpoint}` };
    return;
  }

  if (!response.ok) {
    yield { type: 'error', text: `Agent error ${response.status}` };
    return;
  }

  if (!response.body) {
    yield { type: 'error', text: 'No body' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let eventType = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          eventType = '';
          continue;
        }
        if (trimmed.startsWith('event: ')) {
          eventType = trimmed.slice(7);
          continue;
        }
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6);
          try {
            const data = JSON.parse(dataStr);
            switch (eventType) {
              case 'chunk':
                yield { type: 'chunk', text: data.text };
                break;
              case 'tool_call':
                yield {
                  type: 'tool_call',
                  toolCall: { id: data.id, name: data.name, arguments: data.arguments },
                };
                break;
              case 'done':
                yield { type: 'done' };
                break;
              case 'error':
                yield { type: 'error', text: data.text };
                break;
            }
          } catch { /* skip */ }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Index workspace files on the agent backend for RAG.
 */
export async function indexWorkspace(
  endpoint: string,
  apiKey: string,
  workspaceId: string,
  files: Array<{ path: string; content: string }>
): Promise<{ indexed: number }> {
  const resp = await fetch(`${endpoint}/v1/index`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ workspace_id: workspaceId, files }),
  });
  if (!resp.ok) throw new Error(`Index failed: ${resp.status}`);
  return resp.json() as Promise<{ indexed: number }>;
}

/**
 * Check connection to agent backend.
 */
export async function checkAgentConnection(endpoint: string, _apiKey: string): Promise<boolean> {
  try {
    const resp = await fetch(`${endpoint}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
