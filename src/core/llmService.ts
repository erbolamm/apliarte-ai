import { logger } from '../utils/logger';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelInfo {
  id: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
  temperature?: number;
  model?: string;
  timeoutMs?: number;
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
