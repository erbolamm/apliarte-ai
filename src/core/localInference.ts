import { logger } from '../utils/logger';
import type { ChatMessage, StreamOptions, ModelInfo } from './llmService';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Store references dynamically — transformers.js is ESM-only
let _pipelineFn: any = null;
let _TextStreamerClass: any = null;

let _generator: any = null;
let _currentModelId: string | null = null;
let _loading = false;
let _depsDir: string | null = null;

export interface LocalModelEntry {
  id: string;
  label: string;
  size: string;
  recommended?: boolean;
}

// Models confirmed to work with transformers.js v4 + ONNX
export const AVAILABLE_MODELS: LocalModelEntry[] = [
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    label: 'Qwen 2.5 0.5B (ultra-rápido)',
    size: '~350MB',
    recommended: true,
  },
  {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    label: 'Qwen 2.5 1.5B (buen balance)',
    size: '~1GB',
  },
  {
    id: 'onnx-community/Qwen2.5-3B-Instruct',
    label: 'Qwen 2.5 3B (mejor calidad)',
    size: '~2GB',
  },
  {
    id: 'onnx-community/SmolLM2-360M-Instruct',
    label: 'SmolLM2 360M (mínimo)',
    size: '~250MB',
  },
];

/**
 * Set the directory where on-demand dependencies will be installed.
 * Must be called once at activation with context.globalStorageUri.fsPath.
 */
export function setDepsDirectory(dir: string): void {
  _depsDir = dir;
}

function getDepsDir(): string {
  if (!_depsDir) throw new Error('Dependencies directory not set. Call setDepsDirectory first.');
  return _depsDir;
}

/**
 * Check if @huggingface/transformers is installed in the deps directory.
 */
export function areDepsInstalled(): boolean {
  const dir = getDepsDir();
  return existsSync(join(dir, 'node_modules', '@huggingface', 'transformers'));
}

/**
 * Install @huggingface/transformers into the deps directory on demand.
 */
export async function installDeps(
  onProgress?: (msg: string) => void
): Promise<void> {
  const dir = getDepsDir();

  if (areDepsInstalled()) {
    logger.info('Dependencias de inferencia local ya instaladas');
    return;
  }

  logger.info(`Instalando dependencias en ${dir}...`);
  onProgress?.('Instalando transformers.js (primera vez, puede tardar ~1 min)…');

  // Create dir + package.json
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'apliarte-ai-local',
    private: true,
    dependencies: {
      '@huggingface/transformers': '^4.0.1',
    },
  }));

  // Run npm install
  await new Promise<void>((resolve, reject) => {
    const child = execFile('npm', ['install', '--production'], {
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'production' },
      maxBuffer: 10 * 1024 * 1024,
    }, (error) => {
      if (error) {
        reject(new Error(`npm install falló: ${error.message}`));
      } else {
        resolve();
      }
    });

    child.stdout?.on('data', (data: string) => {
      logger.info(`[npm] ${data.trim()}`);
    });
    child.stderr?.on('data', (data: string) => {
      // npm outputs progress to stderr
      const line = data.trim();
      if (line) onProgress?.(line.slice(0, 80));
    });
  });

  logger.info('Dependencias instaladas correctamente');
  onProgress?.('Dependencias instaladas');
}

async function ensureImported(): Promise<void> {
  if (_pipelineFn) return;

  if (!areDepsInstalled()) {
    throw new Error('Las dependencias de inferencia local no están instaladas. Seleccioná modo Local para instalarlas.');
  }

  // Dynamic import from the deps directory
  const depsDir = getDepsDir();
  const transformersPath = join(depsDir, 'node_modules', '@huggingface', 'transformers');

  // Add to module resolution paths
  const Module = require('module');
  const originalPaths = Module._nodeModulePaths;
  const depsNodeModules = join(depsDir, 'node_modules');

  // Temporarily add our deps dir to resolution
  if (!require.resolve.paths('')?.includes(depsNodeModules)) {
    Module._nodeModulePaths = function(from: string) {
      const paths = originalPaths.call(this, from);
      if (!paths.includes(depsNodeModules)) {
        paths.unshift(depsNodeModules);
      }
      return paths;
    };
  }

  const mod = await import(transformersPath);
  _pipelineFn = mod.pipeline;
  _TextStreamerClass = mod.TextStreamer;
}

export async function loadModel(
  modelId: string,
  onProgress?: (info: { status: string; progress?: number; file?: string }) => void
): Promise<void> {
  if (_currentModelId === modelId && _generator) return;
  if (_loading) throw new Error('Ya se está cargando un modelo');

  _loading = true;
  try {
    await ensureImported();
    logger.info(`Cargando modelo local: ${modelId}`);

    // Dispose previous model if any
    if (_generator) {
      await _generator.dispose?.();
      _generator = null;
      _currentModelId = null;
    }

    _generator = await _pipelineFn('text-generation', modelId, {
      dtype: 'q4',
      progress_callback: (data: Record<string, unknown>) => {
        if (onProgress && data.status) {
          onProgress({
            status: data.status as string,
            progress: data.progress as number | undefined,
            file: data.file as string | undefined,
          });
        }
      },
    });

    _currentModelId = modelId;
    logger.info(`Modelo local cargado: ${modelId}`);
  } finally {
    _loading = false;
  }
}

export function isModelLoaded(): boolean {
  return _generator !== null;
}

export function getLoadedModel(): string | null {
  return _currentModelId;
}

export function isLoading(): boolean {
  return _loading;
}

export async function streamChatLocal(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options?: StreamOptions
): Promise<void> {
  if (!_generator) {
    throw new Error('No hay modelo local cargado. Seleccioná y descargá un modelo primero.');
  }

  logger.info(`Inferencia local: ${messages.length} msgs, model=${_currentModelId}`);

  let aborted = false;
  if (options?.signal) {
    options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  }

  await _generator(messages, {
    max_new_tokens: 2048,
    temperature: options?.temperature ?? 0.7,
    do_sample: (options?.temperature ?? 0.7) > 0,
    streamer: new _TextStreamerClass(_generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        if (aborted) return;
        onChunk(text);
      },
    }),
  });
}

export async function listLocalModels(): Promise<ModelInfo[]> {
  return AVAILABLE_MODELS.map((m) => ({ id: m.id }));
}

export async function unloadModel(): Promise<void> {
  if (_generator) {
    await _generator.dispose?.();
    _generator = null;
    _currentModelId = null;
    logger.info('Modelo local descargado de memoria');
  }
}
