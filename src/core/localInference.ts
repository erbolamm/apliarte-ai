import { logger } from '../utils/logger';
import type { ChatMessage, StreamOptions, ModelInfo } from './llmService';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'fs';
import { homedir } from 'os';
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

export interface ScannedModel {
  id: string;
  type: 'onnx' | 'gguf' | 'ollama';
  localPath: string;
}

// Dirs that are never model dirs — skip to avoid noise and deep traversal
const _SKIP_DIRS = new Set([
  'blobs', 'manifests', 'logs', 'extensions', 'backends',
  'db', 'threads', 'node_modules', 'dist', '.git', 'mlx',
]);

function _scanRecursive(
  baseDir: string,
  currentDir: string,
  rel: string,
  depth: number,
  out: ScannedModel[],
): void {
  if (depth > 4) return;

  let entries: string[];
  try { entries = readdirSync(currentDir); } catch { return; }

  const files: string[] = [];
  const subdirs: string[] = [];
  for (const e of entries) {
    try {
      if (statSync(join(currentDir, e)).isDirectory()) subdirs.push(e);
      else files.push(e);
    } catch { /* skip */ }
  }

  // ── HF cache entry (models--ORG--NAME) ──
  // Detected by dirname, not by position — works at any depth
  const dirName = currentDir === baseDir ? '' : currentDir.slice(baseDir.length + 1).split('/').pop()!;
  if (dirName.startsWith('models--')) {
    const parts = dirName.slice('models--'.length).split('--');
    if (parts.length >= 2 && subdirs.includes('snapshots')) {
      try {
        const snapDir = join(currentDir, 'snapshots');
        const hashes = readdirSync(snapDir).filter((h) => {
          try { return statSync(join(snapDir, h)).isDirectory(); } catch { return false; }
        });
        for (const hash of hashes) {
          const snapFiles = readdirSync(join(snapDir, hash));
          if (snapFiles.some((f) => f.endsWith('.onnx') || f.endsWith('.safetensors'))) {
            out.push({ id: parts.join('/'), type: 'onnx', localPath: currentDir });
            return;
          }
          if (snapFiles.some((f) => f.endsWith('.gguf'))) {
            out.push({ id: parts.join('/'), type: 'gguf', localPath: currentDir });
            return;
          }
          // has snapshots but unknown format — skip (TTS, vision, etc.)
        }
      } catch { /* skip */ }
    }
    return; // never recurse inside models-- dirs
  }

  // ── GGUF files directly here ──
  const ggufFiles = files.filter((f) => f.endsWith('.gguf'));
  if (ggufFiles.length > 0 && rel) {
    out.push({ id: rel, type: 'gguf', localPath: currentDir });
    return;
  }

  // ── ONNX/safetensors + config.json ──
  if (files.includes('config.json') && rel) {
    const hasOnnx = files.some((f) => f.endsWith('.onnx') || f.endsWith('.safetensors'));
    if (hasOnnx) {
      out.push({ id: rel, type: 'onnx', localPath: currentDir });
      return;
    }
  }

  // ── Recurse into subdirs ──
  for (const sub of subdirs) {
    if (_SKIP_DIRS.has(sub)) continue;
    const newRel = rel ? `${rel}/${sub}` : sub;
    _scanRecursive(baseDir, join(currentDir, sub), newRel, depth + 1, out);
  }
}

/**
 * Scan Ollama's manifest store and return models as informational entries.
 * Ollama uses a blob/manifest system — models are NOT movable as plain files.
 * Models are read-only informational: shown in UI but not loadable by the extension.
 *
 * Layout: $OLLAMA_MODELS/manifests/registry.ollama.ai/library/{name}/{tag}
 * Each manifest file is JSON — presence of the file means the model is pulled.
 */
export function scanOllamaModels(): ScannedModel[] {
  const base = process.env.OLLAMA_MODELS
    ?? join(homedir(), '.ollama', 'models');
  const libraryDir = join(base, 'manifests', 'registry.ollama.ai', 'library');

  if (!existsSync(libraryDir)) return [];

  const results: ScannedModel[] = [];
  let modelDirs: string[];
  try { modelDirs = readdirSync(libraryDir); } catch { return []; }

  for (const modelName of modelDirs) {
    const modelPath = join(libraryDir, modelName);
    try {
      if (!statSync(modelPath).isDirectory()) continue;
      const tags = readdirSync(modelPath);
      for (const tag of tags) {
        const manifestPath = join(modelPath, tag);
        try {
          if (statSync(manifestPath).isFile()) {
            // Validate it's a real manifest (has JSON with schemaVersion)
            const raw = readFileSync(manifestPath, 'utf8');
            const manifest = JSON.parse(raw) as Record<string, unknown>;
            if (manifest.schemaVersion) {
              results.push({
                id: `${modelName}:${tag}`,
                type: 'ollama',
                localPath: modelPath,
              });
            }
          }
        } catch { /* skip corrupt manifests */ }
      }
    } catch { /* skip unreadable dirs */ }
  }

  return results;
}

export function scanModelsDirTyped(dir: string): ScannedModel[] {
  if (!existsSync(dir)) return [];
  const raw: ScannedModel[] = [];
  _scanRecursive(dir, dir, '', 0, raw);
  const seen = new Map<string, ScannedModel>();
  for (const m of raw) {
    if (!seen.has(m.id)) seen.set(m.id, m);
  }
  return [...seen.values()];
}

// Backward-compat — only ONNX models (loadable with transformers.js)
export function scanModelsDir(dir: string): string[] {
  return scanModelsDirTyped(dir).filter((m) => m.type === 'onnx').map((m) => m.id);
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
