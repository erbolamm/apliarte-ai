import { logger } from '../utils/logger';
import type { ChatMessage, StreamOptions } from './llmService';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

let _llamaFn: any = null;        // getLlama
let _SessionClass: any = null;   // LlamaChatSession

let _llama: any = null;
let _model: any = null;
let _context: any = null;
let _currentPath: string | null = null;
let _loading = false;
let _depsDir: string | null = null;

export function setGgufDepsDirectory(dir: string): void {
  _depsDir = dir;
}

function getDepsDir(): string {
  if (!_depsDir) throw new Error('GGUF deps directory not set. Call setGgufDepsDirectory first.');
  return _depsDir;
}

export function areGgufDepsInstalled(): boolean {
  const dir = getDepsDir();
  return existsSync(join(dir, 'node_modules', 'node-llama-cpp'));
}

export async function installGgufDeps(onProgress?: (msg: string) => void): Promise<void> {
  const dir = getDepsDir();
  if (areGgufDepsInstalled()) return;

  logger.info(`Instalando node-llama-cpp en ${dir}...`);
  onProgress?.('Instalando node-llama-cpp (primera vez, puede tardar unos minutos)…');

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'apliarte-ai-gguf',
    private: true,
    dependencies: { 'node-llama-cpp': '^3.0.0' },
  }));

  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'npm', ['install', '--production'],
      { cwd: dir, env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 20 * 1024 * 1024 },
      (error) => {
        if (error) reject(new Error(`npm install falló: ${error.message}`));
        else resolve();
      },
    );
    child.stderr?.on('data', (data: string) => {
      const line = data.trim();
      if (line) onProgress?.(line.slice(0, 80));
    });
  });

  logger.info('node-llama-cpp instalado correctamente');
  onProgress?.('Dependencias GGUF instaladas');
}

async function ensureImported(): Promise<void> {
  if (_llamaFn) return;
  if (!areGgufDepsInstalled()) throw new Error('Dependencias GGUF no instaladas.');

  const depsDir = getDepsDir();
  const entryPath = join(depsDir, 'node_modules', 'node-llama-cpp', 'dist', 'index.js');
  const mod = await import(entryPath);
  _llamaFn = mod.getLlama;
  _SessionClass = mod.LlamaChatSession;
}

export async function loadGgufModel(
  filePath: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  if (_currentPath === filePath && _model) return;
  if (_loading) throw new Error('Ya se está cargando un modelo GGUF.');

  _loading = true;
  try {
    await ensureImported();
    logger.info(`Cargando modelo GGUF: ${filePath}`);

    await unloadGgufModel();

    if (!_llama) {
      _llama = await _llamaFn();
    }

    _model = await _llama.loadModel({
      modelPath: filePath,
      onLoadProgress: (pct: number) => onProgress?.(Math.round(pct * 100)),
    });
    _context = await _model.createContext();
    _currentPath = filePath;
    logger.info(`Modelo GGUF cargado: ${filePath}`);
  } finally {
    _loading = false;
  }
}

export function isGgufModelLoaded(): boolean {
  return _model !== null;
}

export function getLoadedGgufModel(): string | null {
  return _currentPath;
}

export function isGgufLoading(): boolean {
  return _loading;
}

export async function streamChatGguf(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options?: StreamOptions,
): Promise<void> {
  if (!_model || !_context) {
    throw new Error('No hay modelo GGUF cargado.');
  }

  let aborted = false;
  if (options?.signal) {
    options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  }

  const sequence = _context.getSequence();
  const session = new _SessionClass({ contextSequence: sequence });

  // Inject history except last user message
  const history = messages.slice(0, -1).map((m: ChatMessage) => ({
    type: m.role === 'user' ? 'human' : 'model',
    text: m.content,
  }));
  if (history.length > 0) {
    session.setChatHistory(history);
  }

  const lastMsg = messages[messages.length - 1];
  const prompt = lastMsg?.content ?? '';

  let tokenCount = 0;
  const startTime = Date.now();

  await session.prompt(prompt, {
    signal: options?.signal,
    onTextChunk: (chunk: string) => {
      if (aborted) return;
      tokenCount++;
      onChunk(chunk);
    },
  });

  const elapsed = (Date.now() - startTime) / 1000;
  if (!aborted && elapsed > 0.5 && options?.onStats) {
    options.onStats({
      tokensPerSecond: Math.round((tokenCount / elapsed) * 10) / 10,
      totalTokens: tokenCount,
      model: _currentPath ?? '',
    });
  }
}

export async function unloadGgufModel(): Promise<void> {
  if (_context) { await _context.dispose?.(); _context = null; }
  if (_model)   { await _model.dispose?.();   _model = null; }
  _currentPath = null;
  logger.info('Modelo GGUF descargado de memoria');
}
