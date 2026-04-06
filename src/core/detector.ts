import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export interface LocalProvider {
  name: string;
  type: 'lmstudio' | 'ollama';
  endpoint: string;
  models: string[];
}

/**
 * Detecta si LM Studio u Ollama están corriendo localmente.
 * Intenta conectarse a los endpoints configurados y listar modelos.
 */
export async function detectProviders(): Promise<LocalProvider[]> {
  const config = vscode.workspace.getConfiguration('gentleAiConnect');
  const lmstudioUrl = config.get<string>('lmstudioEndpoint', 'http://localhost:1234/v1');
  const ollamaUrl = config.get<string>('ollamaEndpoint', 'http://localhost:11434');

  const providers: LocalProvider[] = [];

  // Detectar LM Studio
  const lmstudio = await tryEndpoint('LM Studio', 'lmstudio', `${lmstudioUrl}/models`);
  if (lmstudio) {
    providers.push(lmstudio);
  }

  // Detectar Ollama
  const ollama = await tryEndpoint('Ollama', 'ollama', `${ollamaUrl}/api/tags`);
  if (ollama) {
    providers.push(ollama);
  }

  logger.info(`Proveedores detectados: ${providers.length}`);
  return providers;
}

async function tryEndpoint(
  name: string,
  type: 'lmstudio' | 'ollama',
  url: string
): Promise<LocalProvider | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn(`${name}: respuesta ${response.status} en ${url}`);
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const models = extractModelNames(data, type);

    logger.info(`${name} detectado en ${url} — modelos: ${models.join(', ')}`);
    return { name, type, endpoint: url.replace(/\/(models|api\/tags)$/, ''), models };
  } catch {
    logger.info(`${name} no disponible en ${url}`);
    return null;
  }
}

function extractModelNames(data: Record<string, unknown>, type: string): string[] {
  if (type === 'lmstudio' && Array.isArray(data.data)) {
    return (data.data as Array<{ id?: string }>).map((m) => m.id ?? 'unknown');
  }
  if (type === 'ollama' && Array.isArray(data.models)) {
    return (data.models as Array<{ name?: string }>).map((m) => m.name ?? 'unknown');
  }
  return [];
}
