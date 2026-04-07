import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';

interface HardwareProfile {
  os: string;
  arch: string;
  chip?: string;
  ramGB: number;
  gpuVRAM?: number;
  gpu?: string;
}

interface ModelRec {
  name: string;
  size: string;
  params: string;
  provider: string;
  why: string;
  downloadUrl: string;
  contextLen: string;
  tasks: string[];
}

function detectHardware(): HardwareProfile {
  const os = process.platform === 'darwin' ? 'macOS'
    : process.platform === 'win32' ? 'Windows'
    : 'Linux';
  const arch = process.arch === 'arm64' ? 'ARM64 (Apple Silicon / Snapdragon)' : 'x86_64';

  let ramGB = 8;
  let chip: string | undefined;
  let gpu: string | undefined;
  let gpuVRAM: number | undefined;

  try {
    if (process.platform === 'darwin') {
      // macOS — sysctl for RAM
      const memBytes = execSync('sysctl -n hw.memsize', { encoding: 'utf-8' }).trim();
      ramGB = Math.round(parseInt(memBytes, 10) / (1024 ** 3));
      // Chip name
      try {
        chip = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf-8' }).trim();
      } catch {
        // Apple Silicon may not have brand_string
        if (process.arch === 'arm64') chip = 'Apple Silicon';
      }
      // GPU on Apple Silicon = unified memory
      if (process.arch === 'arm64') {
        gpu = chip ?? 'Apple Silicon GPU';
        gpuVRAM = ramGB; // unified memory
      }
    } else if (process.platform === 'linux') {
      const memInfo = execSync('grep MemTotal /proc/meminfo', { encoding: 'utf-8' });
      const kbMatch = memInfo.match(/(\d+)/);
      if (kbMatch) ramGB = Math.round(parseInt(kbMatch[1], 10) / (1024 ** 2));
      // Try nvidia-smi
      try {
        const nvOut = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', { encoding: 'utf-8' }).trim();
        const [gpuName, vram] = nvOut.split(',').map(s => s.trim());
        gpu = gpuName;
        gpuVRAM = Math.round(parseInt(vram, 10) / 1024);
      } catch { /* no nvidia */ }
    } else {
      // Windows
      try {
        const wmicMem = execSync('wmic ComputerSystem get TotalPhysicalMemory /format:value', { encoding: 'utf-8' });
        const memMatch = wmicMem.match(/TotalPhysicalMemory=(\d+)/);
        if (memMatch) ramGB = Math.round(parseInt(memMatch[1], 10) / (1024 ** 3));
      } catch { /* fallback */ }
      try {
        const nvOut = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', { encoding: 'utf-8' }).trim();
        const [gpuName, vram] = nvOut.split(',').map(s => s.trim());
        gpu = gpuName;
        gpuVRAM = Math.round(parseInt(vram, 10) / 1024);
      } catch { /* no nvidia */ }
    }
  } catch (e) {
    logger.error(`Hardware detection partial failure: ${e}`);
  }

  return { os, arch, chip, ramGB, gpuVRAM, gpu };
}

function getRecommendations(hw: HardwareProfile): ModelRec[] {
  const effectiveVRAM = hw.gpuVRAM ?? 0;
  const isAppleSilicon = hw.arch.includes('ARM64') && hw.os === 'macOS';
  // Apple Silicon uses unified memory — all RAM is usable for models
  const availableMemory = isAppleSilicon ? hw.ramGB : Math.max(effectiveVRAM, hw.ramGB * 0.6);

  const all: (ModelRec & { minMem: number })[] = [
    // ── Tiny (2-4 GB) ────────────────────────────────────
    {
      name: 'Qwen 2.5 Coder 1.5B',
      size: '~1.5 GB', params: '1.5B', provider: 'LM Studio / Ollama',
      why: 'Ideal para autocompletado rápido. Pequeño pero sorprendentemente bueno en código.',
      downloadUrl: 'lmstudio: qwen2.5-coder-1.5b | ollama: qwen2.5-coder:1.5b',
      contextLen: '32K', tasks: ['autocompletado', 'snippets'], minMem: 2,
    },
    {
      name: 'Gemma 3 1B',
      size: '~1 GB', params: '1B', provider: 'LM Studio / Ollama',
      why: 'Ultra ligero de Google. Bueno para respuestas rápidas.',
      downloadUrl: 'lmstudio: gemma-3-1b-it | ollama: gemma3:1b',
      contextLen: '32K', tasks: ['chat', 'snippets'], minMem: 2,
    },
    // ── Small (4-8 GB) ───────────────────────────────────
    {
      name: 'Gemma 3 4B',
      size: '~3 GB', params: '4B', provider: 'LM Studio / Ollama',
      why: 'Excelente balance tamaño/calidad de Google. Bueno en español.',
      downloadUrl: 'lmstudio: gemma-3-4b-it | ollama: gemma3:4b',
      contextLen: '128K', tasks: ['chat', 'código', 'explicaciones'], minMem: 4,
    },
    {
      name: 'Qwen 2.5 Coder 7B',
      size: '~5 GB', params: '7B', provider: 'LM Studio / Ollama',
      why: 'El MEJOR modelo de código en su tamaño. Genera, refactoriza y explica.',
      downloadUrl: 'lmstudio: qwen2.5-coder-7b-instruct | ollama: qwen2.5-coder:7b',
      contextLen: '32K', tasks: ['código', 'refactor', 'tests', 'docs'], minMem: 6,
    },
    {
      name: 'DeepSeek Coder V2 Lite 16B',
      size: '~6 GB', params: '16B (MoE)', provider: 'LM Studio / Ollama',
      why: 'MoE — usa solo parte de los parámetros. Rinde como uno grande pero cabe en poca RAM.',
      downloadUrl: 'lmstudio: deepseek-coder-v2-lite | ollama: deepseek-coder-v2:16b',
      contextLen: '128K', tasks: ['código', 'análisis', 'refactor'], minMem: 6,
    },
    {
      name: 'Llama 3.1 8B',
      size: '~5 GB', params: '8B', provider: 'LM Studio / Ollama',
      why: 'Todoterreno de Meta. Muy bueno en razonamiento y español.',
      downloadUrl: 'lmstudio: meta-llama-3.1-8b-instruct | ollama: llama3.1:8b',
      contextLen: '128K', tasks: ['chat', 'código', 'razonamiento'], minMem: 6,
    },
    // ── Medium (8-16 GB) ─────────────────────────────────
    {
      name: 'Gemma 4 12B',
      size: '~8 GB', params: '12B', provider: 'LM Studio / Ollama',
      why: 'Último de Google. Excelente en código, razonamiento y multilingüe.',
      downloadUrl: 'lmstudio: gemma-4-12b-it | ollama: gemma4:12b',
      contextLen: '128K', tasks: ['código', 'arquitectura', 'análisis', 'español'], minMem: 10,
    },
    {
      name: 'Qwen 2.5 Coder 14B',
      size: '~10 GB', params: '14B', provider: 'LM Studio / Ollama',
      why: 'Competidor directo de GPT-4 en código. Genera archivos completos con calidad.',
      downloadUrl: 'lmstudio: qwen2.5-coder-14b-instruct | ollama: qwen2.5-coder:14b',
      contextLen: '32K', tasks: ['código', 'refactor', 'tests', 'arquitectura'], minMem: 12,
    },
    {
      name: 'Mistral Nemo 12B',
      size: '~8 GB', params: '12B', provider: 'LM Studio / Ollama',
      why: 'De Mistral AI, excelente en razonamiento y sigue instrucciones muy bien.',
      downloadUrl: 'lmstudio: mistral-nemo-instruct | ollama: mistral-nemo',
      contextLen: '128K', tasks: ['chat', 'razonamiento', 'código'], minMem: 10,
    },
    // ── Large (16-32 GB) ─────────────────────────────────
    {
      name: 'Qwen 2.5 Coder 32B',
      size: '~22 GB', params: '32B', provider: 'LM Studio / Ollama',
      why: 'NIVEL GPT-4 en código. El mejor modelo local para desarrollo. Si te cabe, usa este.',
      downloadUrl: 'lmstudio: qwen2.5-coder-32b-instruct | ollama: qwen2.5-coder:32b',
      contextLen: '32K', tasks: ['código', 'arquitectura', 'refactor', 'tests', 'docs'], minMem: 24,
    },
    {
      name: 'DeepSeek V3 0324',
      size: '~20 GB (Q4)', params: '685B (MoE→37B activos)', provider: 'LM Studio / Ollama',
      why: 'Modelo MoE masivo que solo activa 37B parámetros. Compite con Claude/GPT-4.',
      downloadUrl: 'lmstudio: deepseek-v3-0324 | ollama: deepseek-v3',
      contextLen: '64K', tasks: ['todo', 'arquitectura', 'razonamiento avanzado'], minMem: 24,
    },
    {
      name: 'Llama 3.1 70B (Q4)',
      size: '~40 GB', params: '70B', provider: 'LM Studio / Ollama',
      why: 'El gigante de Meta. Si tienes 64GB+ de RAM en Apple Silicon, es una bestia.',
      downloadUrl: 'lmstudio: meta-llama-3.1-70b-instruct | ollama: llama3.1:70b',
      contextLen: '128K', tasks: ['todo', 'razonamiento complejo', 'arquitectura'], minMem: 48,
    },
  ];

  return all
    .filter(m => m.minMem <= availableMemory)
    .map(({ minMem: _, ...m }) => m);
}

export async function showModelRecommendations(): Promise<void> {
  const hw = detectHardware();

  logger.info(`Hardware: ${hw.os} ${hw.arch} | RAM: ${hw.ramGB}GB | GPU: ${hw.gpu ?? 'integrada'} | VRAM: ${hw.gpuVRAM ?? 'N/A'}GB`);

  const recs = getRecommendations(hw);

  const isAppleSilicon = hw.arch.includes('ARM64') && hw.os === 'macOS';

  let md = `# Modelos recomendados para tu equipo\n\n`;
  md += `## Tu hardware\n`;
  md += `| Propiedad | Valor |\n|---|---|\n`;
  md += `| Sistema | ${hw.os} ${hw.arch} |\n`;
  if (hw.chip) md += `| Chip | ${hw.chip} |\n`;
  md += `| RAM | ${hw.ramGB} GB |\n`;
  if (hw.gpu) md += `| GPU | ${hw.gpu} |\n`;
  if (hw.gpuVRAM && !isAppleSilicon) md += `| VRAM | ${hw.gpuVRAM} GB |\n`;
  if (isAppleSilicon) md += `| Memoria unificada | Sí — toda la RAM es usable por IA |\n`;
  md += `\n`;

  // Group by size
  const tiers: [string, number, number][] = [
    ['Ligero — Respuestas rápidas', 0, 5],
    ['Medio — Balance calidad/velocidad', 5, 15],
    ['Pro — Máxima calidad (más lento)', 15, 999],
  ];

  for (const [label, minParams, maxParams] of tiers) {
    const group = recs.filter(m => {
      const p = parseFloat(m.params);
      return p >= minParams && p < maxParams;
    });
    if (group.length === 0) continue;

    md += `## ${label}\n\n`;
    for (const m of group) {
      md += `### ${m.name}\n`;
      md += `- **Tamaño**: ${m.size} | **Parámetros**: ${m.params}\n`;
      md += `- **Contexto**: ${m.contextLen}\n`;
      md += `- **Para**: ${m.tasks.join(', ')}\n`;
      md += `- **¿Por qué?**: ${m.why}\n`;
      md += `- **Descargar**: \`${m.downloadUrl}\`\n\n`;
    }
  }

  md += `---\n\n`;
  md += `## Consejo rápido\n\n`;

  if (hw.ramGB <= 8) {
    md += `Con ${hw.ramGB}GB de RAM, usa modelos de **1B-4B** parámetros. `;
    md += `**Gemma 3 4B** es tu mejor opción — buen español y rápido.\n`;
  } else if (hw.ramGB <= 16) {
    md += `Con ${hw.ramGB}GB, puedes usar modelos de hasta **12B**. `;
    md += `**Qwen 2.5 Coder 7B** para código puro, **Gemma 4 12B** para todo.\n`;
  } else if (hw.ramGB <= 32) {
    md += `Con ${hw.ramGB}GB, puedes usar **Qwen 2.5 Coder 32B** — `;
    md += `nivel GPT-4 en código, corriendo 100% en tu máquina. Hazlo.\n`;
  } else {
    md += `Con ${hw.ramGB}GB tienes acceso a todo. **Qwen 2.5 Coder 32B** para código, `;
    md += `**Llama 3.1 70B** para razonamiento avanzado.\n`;
  }

  md += `\n## Cómo instalar\n\n`;
  md += `1. Abre **LM Studio** → busca el modelo → "Download"\n`;
  md += `2. O con **Ollama**: \`ollama pull nombre-del-modelo\`\n`;
  md += `3. Carga el modelo y ApliArte AI Chat lo detecta automáticamente\n`;

  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });
}
