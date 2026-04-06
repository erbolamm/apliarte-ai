import * as vscode from 'vscode';
import { logger } from './utils/logger';
import { detectProviders } from './core/detector';
import { setupContinue } from './core/setup';
import { changePreset } from './core/preset';

/**
 * Punto de entrada de la extensión.
 * VS Code llama a esta función cuando la extensión se activa.
 */
export function activate(context: vscode.ExtensionContext): void {
  logger.activate();
  logger.info('Gentle AI Connect v0.1.0 — activando...');

  // Comando principal: configurar todo
  context.subscriptions.push(
    vscode.commands.registerCommand('gentleAiConnect.setup', async () => {
      const providers = await detectProviders();
      if (providers.length === 0) {
        vscode.window.showWarningMessage(
          'No se detectó LM Studio ni Ollama. Asegurate de tener uno corriendo.'
        );
        return;
      }
      await setupContinue(context, providers);
    })
  );

  // Detectar proveedores disponibles
  context.subscriptions.push(
    vscode.commands.registerCommand('gentleAiConnect.detectProviders', async () => {
      const providers = await detectProviders();
      if (providers.length === 0) {
        vscode.window.showInformationMessage('No se detectaron proveedores locales.');
      } else {
        const names = providers.map((p) => p.name).join(', ');
        vscode.window.showInformationMessage(`Proveedores detectados: ${names}`);
      }
    })
  );

  // Cambiar preset
  context.subscriptions.push(
    vscode.commands.registerCommand('gentleAiConnect.changePreset', () => changePreset())
  );

  logger.info('Gentle AI Connect activado correctamente.');
}

export function deactivate(): void {
  logger.info('Gentle AI Connect desactivado.');
}
