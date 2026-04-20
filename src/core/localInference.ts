import { logger } from '../utils/logger';
import type { ChatMessage, StreamOptions, ModelInfo } from './llmService';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Store references dynamically — transformers.js is ESM-only
let _pipelineFn: any = null;
let _TextStreamerClass: any = null;

let _generator: any = null;
let _currentModelId: string | null = null;
let _loading = false;
let _depsDir: string | null = null;
let _modelsDir: string | null = null;

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
    id: 'onnx-community/Qwen2.5-Coder-3B-Instruct',
    label: 'Qwen 2.5 Coder 3B (mejor calidad)',
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

/**
 * Set the directory where AI models are stored.
 * Pass empty string to use the default (inside globalStorageUri).
 */
export function setModelsDirectory(dir: string): void {
  _modelsDir = dir || null;
  logger.info(`[localInference] modelsDir = ${_modelsDir ?? '(default HF cache)'}`);
}

export function getModelsDirectory(): string | null {
  return _modelsDir;
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
    throw new Error('Las dependencias de inferencia local no están instaladas. Selecciona modo Local para instalarlas.');
  }

  // Dynamic import from the deps directory.
  // Must point to the concrete CJS entry point — Node cannot resolve directory imports
  // in ESM context. transformers.node.cjs is the correct Node.js build.
  const depsDir = getDepsDir();
  const transformersPath = join(depsDir, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.cjs');

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

    const pipelineOpts: Record<string, unknown> = {
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
    };
    if (_modelsDir) {
      pipelineOpts.cache_dir = _modelsDir;
    }

    _generator = await _pipelineFn('text-generation', modelId, pipelineOpts);

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
    throw new Error('No hay modelo local cargado. Selecciona y descarga un modelo primero.');
  }

  logger.info(`Inferencia local: ${messages.length} msgs, model=${_currentModelId}`);

  let aborted = false;
  if (options?.signal) {
    options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  }

  let tokenCount = 0;
  const startTime = Date.now();

  await _generator(messages, {
    max_new_tokens: 2048,
    temperature: options?.temperature ?? 0.7,
    do_sample: (options?.temperature ?? 0.7) > 0,
    streamer: new _TextStreamerClass(_generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        if (aborted) return;
        tokenCount++;
        onChunk(text);
      },
    }),
  });

  const elapsed = (Date.now() - startTime) / 1000;
  if (!aborted && elapsed > 0.5 && options?.onStats) {
    options.onStats({
      tokensPerSecond: Math.round((tokenCount / elapsed) * 10) / 10,
      totalTokens: tokenCount,
      model: _currentModelId ?? '',
    });
  }
}

const MODEL_EXTS = new Set(['.onnx', '.safetensors', '.gguf', '.bin']);

function _hasModelFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => MODEL_EXTS.has(f.slice(f.lastIndexOf('.'))));
  } catch { return false; }
}

/**
 * Scan a directory for locally cached HuggingFace models.
 *
 * Supports three layouts:
 *   1. HF cache:   models--{org}--{name}/snapshots/<hash>/  (verifies snapshots exist)
 *   2. Plain repo: {name}/config.json + model files
 *   3. Org/repo:   {org}/{name}/config.json + model files  (one level deeper)
 */
export function scanModelsDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    logger.warn(`[localInference] scanModelsDir failed reading ${dir}: ${(err as Error).message}`);
    return [];
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const st = statSync(fullPath);
      if (!st.isDirectory()) continue;

      // ── Layout 1: HF cache (models--ORG--NAME) ──────────────
      if (entry.startsWith('models--')) {
        const parts = entry.slice('models--'.length).split('--');
        if (parts.length >= 2) {
          // Only include if snapshots directory has content (model actually downloaded)
          const snapshotsDir = join(fullPath, 'snapshots');
          if (existsSync(snapshotsDir)) {
            try {
              const hashes = readdirSync(snapshotsDir).filter((h) => {
                try { return statSync(join(snapshotsDir, h)).isDirectory(); } catch { return false; }
              });
              if (hashes.length > 0) found.push(parts.join('/'));
            } catch { found.push(parts.join('/')); } // can't read snapshots, assume it's there
          }
        }
        continue;
      }

      // ── Layout 2: plain HF repo (dir has config.json + model files) ──
      const hasConfig = existsSync(join(fullPath, 'config.json'));
      if (hasConfig && _hasModelFiles(fullPath)) {
        found.push(entry);
        continue;
      }

      // ── Layout 3: org/repo (one level deeper) ────────────────
      try {
        for (const sub of readdirSync(fullPath)) {
          const subPath = join(fullPath, sub);
          try {
            if (!statSync(subPath).isDirectory()) continue;
            if (existsSync(join(subPath, 'config.json')) && _hasModelFiles(subPath)) {
              found.push(`${entry}/${sub}`);
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    } catch { /* skip unreadable */ }
  }

  return [...new Set(found)];
}

export async function listLocalModels(): Promise<ModelInfo[]> {
  const catalog = AVAILABLE_MODELS.map((m) => ({ id: m.id }));

  // Merge with models found in the user's modelsDir (not in catalog)
  if (_modelsDir) {
    const scanned = scanModelsDir(_modelsDir);
    const catalogIds = new Set(catalog.map((m) => m.id));
    for (const id of scanned) {
      if (!catalogIds.has(id)) {
        catalog.push({ id });
      }
    }
  }

  return catalog;
}

export async function unloadModel(): Promise<void> {
  if (_generator) {
    await _generator.dispose?.();
    _generator = null;
    _currentModelId = null;
    logger.info('Modelo local descargado de memoria');
  }
}
