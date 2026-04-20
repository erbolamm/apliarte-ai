import { logger } from '../utils/logger';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelInfo {
  id: string;
}

export interface InferenceStats {
  tokensPerSecond: number;
  totalTokens: number;
  model: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
  temperature?: number;
  model?: string;
  timeoutMs?: number;
  onStats?: (stats: InferenceStats) => void;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface StreamEvent {
  type: 'chunk' | 'tool_call' | 'done' | 'error';
  text?: string;
  toolCall?: ToolCall;
}

export async function streamChat(
  endpoint: string,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options?: StreamOptions
): Promise<void> {
  const url = `${endpoint}/chat/completions`;
  const timeoutMs = options?.timeoutMs ?? 30_000;

  logger.info(`Request → ${url} (${messages.length} msgs, model=${options?.model ?? 'auto'})`);

  // Combine user abort signal + timeout into one
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (options?.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const body: Record<string, unknown> = {
    messages,
    stream: true,
    temperature: options?.temperature ?? 0.7,
    max_tokens: 4096,
  };
  // Always include model — LM Studio needs it
  if (options?.model) {
    body.model = options.model;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      // Re-check: was it the user or the timeout?
      if (options?.signal?.aborted) throw err;
      throw new Error(`Timeout (${timeoutMs / 1000}s). ¿Está LM Studio/Ollama respondiendo?`);
    }
    throw new Error(`No se pudo conectar a ${endpoint}. ¿Está LM Studio u Ollama corriendo?`);
  }

  clearTimeout(timer);

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errBody = await response.text();
      if (errBody) detail = errBody.slice(0, 200);
    } catch { /* ignore */ }
    throw new Error(`LM Studio → ${response.status}: ${detail}`);
  }
  if (!response.body) {
    throw new Error('No body en la respuesta');
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

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) onChunk(content);
        } catch {
          // Incomplete JSON fragment
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streaming chat with OpenAI-compatible tool-calling.
 *
 * Yields `chunk` events as content streams in, `tool_call` events after the
 * model requests tool invocations (accumulated across delta fragments), and
 * `done` when the turn finishes without tool calls. When tool_calls are
 * yielded, the caller is responsible for executing them and re-invoking this
 * function with the updated message history (append assistant w/ tool_calls,
 * then a `tool` message per result).
 *
 * LM Studio and Ollama both implement this protocol for models that support it.
 */
export async function* streamChatWithTools(
  endpoint: string,
  messages: ChatMessage[],
  tools: ToolDescriptor[],
  options?: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const url = `${endpoint}/chat/completions`;
  const timeoutMs = options?.timeoutMs ?? 60_000;

  logger.info(`Request (tools) → ${url} (${messages.length} msgs, ${tools.length} tools)`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options?.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const body: Record<string, unknown> = {
    messages,
    stream: true,
    temperature: options?.temperature ?? 0.7,
    max_tokens: 4096,
  };
  if (options?.model) body.model = options.model;
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
    body.tool_choice = 'auto';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      if (options?.signal?.aborted) throw err;
      yield { type: 'error', text: `Timeout (${timeoutMs / 1000}s). ¿Está LM Studio/Ollama respondiendo?` };
      return;
    }
    yield { type: 'error', text: `No se pudo conectar a ${endpoint}. ¿Está LM Studio u Ollama corriendo?` };
    return;
  }

  clearTimeout(timer);

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errBody = await response.text();
      if (errBody) detail = errBody.slice(0, 200);
    } catch { /* ignore */ }
    yield { type: 'error', text: `LM Studio → ${response.status}: ${detail}` };
    return;
  }
  if (!response.body) {
    yield { type: 'error', text: 'No body en la respuesta' };
    return;
  }

  const acc = new Map<number, { id: string; name: string; argumentsStr: string }>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | undefined;

  const flushToolCalls = function* (): Generator<StreamEvent> {
    const ordered = [...acc.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, tc] of ordered) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.argumentsStr || '{}') as Record<string, unknown>; } catch { /* keep {} */ }
      yield { type: 'tool_call', toolCall: { id: tc.id, name: tc.name, arguments: args } };
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          if (acc.size > 0) {
            yield* flushToolCalls();
            return;
          }
          yield { type: 'done' };
          return;
        }

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
          };
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;
          if (choice?.finish_reason) finishReason = choice.finish_reason;

          if (delta?.content) yield { type: 'chunk', text: delta.content };

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const cur = acc.get(tc.index) ?? { id: '', name: '', argumentsStr: '' };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (tc.function?.arguments) cur.argumentsStr += tc.function.arguments;
              acc.set(tc.index, cur);
            }
          }
        } catch {
          // Incomplete JSON fragment
        }
      }
    }

    // Stream ended without explicit [DONE]
    if (acc.size > 0 && (finishReason === 'tool_calls' || finishReason === undefined)) {
      yield* flushToolCalls();
      return;
    }
    yield { type: 'done' };
  } finally {
    reader.releaseLock();
  }
}

export async function listModels(endpoint: string): Promise<ModelInfo[]> {
  try {
    const response = await fetch(`${endpoint}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => ({ id: m.id }));
  } catch {
    return [];
  }
}

export async function checkConnection(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
