import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { logger } from '../utils/logger';
import { LocalProvider } from './detector';
import { getRulesForPreset, type PresetId } from './preset';

/**
 * Configura Continue con el ecosistema Gentle AI.
 *
 * 1. Detecta el directorio de Continue (~/.continue/)
 * 2. Crea/actualiza config.yaml con el provider detectado
 * 3. Inyecta las rules según el preset seleccionado
 */
export async function setupContinue(
  _context: vscode.ExtensionContext,
  providers: LocalProvider[]
): Promise<void> {
  const continueDir = path.join(os.homedir(), '.continue');
  const rulesDir = path.join(continueDir, 'rules');

  // Verificar que Continue está instalado
  if (!fs.existsSync(continueDir)) {
    vscode.window.showErrorMessage(
      'No se encontró ~/.continue/. Instalá la extensión Continue primero.'
    );
    return;
  }

  // Elegir provider si hay varios
  let provider: LocalProvider;
  if (providers.length === 1) {
    provider = providers[0];
  } else {
    const picked = await vscode.window.showQuickPick(
      providers.map((p) => ({ label: p.name, description: p.models.join(', '), provider: p })),
      { placeHolder: 'Seleccioná el proveedor de IA local' }
    );
    if (!picked) {
      return;
    }
    provider = (picked as { provider: LocalProvider }).provider;
  }

  // Elegir modelo si hay varios
  let model: string;
  if (provider.models.length === 1) {
    model = provider.models[0];
  } else if (provider.models.length > 1) {
    const pickedModel = await vscode.window.showQuickPick(
      provider.models.map((m) => ({ label: m })),
      { placeHolder: 'Seleccioná el modelo' }
    );
    if (!pickedModel) {
      return;
    }
    model = pickedModel.label;
  } else {
    model = 'AUTODETECT';
  }

  // Obtener preset
  const config = vscode.workspace.getConfiguration('gentleAiConnect');
  const preset = config.get<PresetId>('preset', 'minimal');

  // Crear directorio de rules si no existe
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }

  // Escribir la rule principal
  const rules = getRulesForPreset(preset);
  const rulePath = path.join(rulesDir, 'gentle-ai.md');
  fs.writeFileSync(rulePath, rules, 'utf-8');

  logger.info(`Rule escrita en ${rulePath} (preset: ${preset})`);
  logger.info(`Provider: ${provider.name}, Modelo: ${model}`);

  vscode.window.showInformationMessage(
    `Gentle AI configurado: ${provider.name} / ${model} / preset ${preset}`
  );
}
