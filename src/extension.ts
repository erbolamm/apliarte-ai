import * as vscode from 'vscode';
import { logger } from './utils/logger';
import { detectProviders } from './core/detector';
import { setupContinue } from './core/setup';
import { changePreset } from './core/preset';
import { ChatViewProvider } from './ui/chatView';
import { WorkspaceTreeProvider } from './ui/workspaceView';
import { QUICK_ACTIONS, executeQuickAction } from './ui/quickActions';
import { showModelRecommendations } from './core/modelRecommender';
import { setDepsDirectory } from './core/localInference';

export function activate(context: vscode.ExtensionContext): void {
  logger.activate();
  logger.info('ApliArte AI v0.4.0 — activando...');

  // ── Local inference deps directory ─────────────────────
  setDepsDirectory(context.globalStorageUri.fsPath);

  // ── Chat panel ─────────────────────────────────────────
  const chatProvider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider)
  );

  // ── Workspace tree ─────────────────────────────────────
  const wsTree = new WorkspaceTreeProvider();
  context.subscriptions.push(
    vscode.window.createTreeView('apliarteAi.workspaceView', {
      treeDataProvider: wsTree,
      canSelectMany: false,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.toggleFile', (node) => {
      wsTree.toggleCheck(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.refreshWorkspace', () => {
      wsTree.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.sendSelectedFiles', async () => {
      const files = wsTree.getCheckedFiles();
      if (files.length === 0) {
        vscode.window.showWarningMessage('Seleccioná al menos un archivo del workspace.');
        return;
      }

      const parts: string[] = [];
      for (const uri of files) {
        try {
          const content = await vscode.workspace.fs.readFile(uri);
          const name = uri.path.split('/').pop() ?? 'archivo';
          parts.push(`--- ${name} ---\n${Buffer.from(content).toString('utf-8')}`);
        } catch {
          // skip unreadable files
        }
      }

      if (parts.length > 0) {
        chatProvider.attachContext(
          `${files.length} archivo${files.length > 1 ? 's' : ''}`,
          parts.join('\n\n')
        );
        wsTree.clearChecks();
        vscode.commands.executeCommand('apliarteAi.chatView.focus');
      }
    })
  );

  // ── Quick actions ──────────────────────────────────────
  for (const action of QUICK_ACTIONS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`apliarteAi.action.${action.id}`, () => {
        executeQuickAction(action, chatProvider);
      })
    );
  }

  // ── Send file / selection to chat ──────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.sendFileToChat', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No hay editor activo.');
        return;
      }
      const text = editor.document.getText();
      const name = editor.document.fileName.split('/').pop() ?? 'archivo';
      chatProvider.attachContext(name, text);
      vscode.commands.executeCommand('apliarteAi.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.sendSelectionToChat', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No hay editor activo.');
        return;
      }
      const sel = editor.document.getText(editor.selection);
      if (!sel) {
        vscode.window.showWarningMessage('No hay texto seleccionado.');
        return;
      }
      const name = `Selección (${editor.document.fileName.split('/').pop()})`;
      chatProvider.attachContext(name, sel);
      vscode.commands.executeCommand('apliarteAi.chatView.focus');
    })
  );

  // ── Setup Continue ─────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.setup', async () => {
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

  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.detectProviders', async () => {
      const providers = await detectProviders();
      if (providers.length === 0) {
        vscode.window.showInformationMessage('No se detectaron proveedores locales.');
      } else {
        const names = providers.map((p) => p.name).join(', ');
        vscode.window.showInformationMessage(`Proveedores detectados: ${names}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.changePreset', () => changePreset())
  );

  // ── Model recommender ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.recommendModels', () => showModelRecommendations())
  );

  logger.info('ApliArte AI activado correctamente.');
}

export function deactivate(): void {
  logger.info('ApliArte AI desactivado.');
}
