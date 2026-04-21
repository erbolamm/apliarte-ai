import * as vscode from 'vscode';
import { logger } from './utils/logger';
import { detectProviders } from './core/detector';
import { setupContinue } from './core/setup';
import { changePreset } from './core/preset';
import { ChatViewProvider } from './ui/chatView';
import { WorkspaceTreeProvider } from './ui/workspaceView';
import { QUICK_ACTIONS, executeQuickAction } from './ui/quickActions';
import { showModelRecommendations } from './core/modelRecommender';
import { setDepsDirectory, setModelsDirectory, scanModelsDir } from './core/localInference';
import { indexWorkspace } from './core/agentService';
import { collectWorkspaceFiles } from './tools/executor';
import { McpServerManager } from './mcp/serverManager';
import { getToolRegistry } from './mcp/toolRegistry';
import { getMcpResourceRegistry } from './mcp/resourceRegistry';
import type { McpServerConfig } from './mcp/types';

let _mcpManager: McpServerManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  logger.activate();
  logger.info('ApliArte AI v0.8.0 — activando...');

  // ── Local inference deps + models directory ────────────
  setDepsDirectory(context.globalStorageUri.fsPath);

  const syncModelsDir = (): void => {
    const dir = vscode.workspace.getConfiguration('apliarteAi').get<string>('modelsDir', '').trim();
    setModelsDirectory(dir);
  };
  syncModelsDir();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('apliarteAi.modelsDir')) syncModelsDir();
    })
  );

  // ── Upgrade prompt: "¿Sigue siendo tu carpeta de modelos?" ─
  const currentVersion = context.extension.packageJSON.version as string ?? '0.0.0';
  const lastVersion = context.globalState.get<string>('installedVersion', '');
  const isUpgrade = lastVersion !== '' && lastVersion !== currentVersion;
  const isFirstRun = lastVersion === '';

  if (isFirstRun || isUpgrade) {
    void context.globalState.update('installedVersion', currentVersion);
    const cfg = vscode.workspace.getConfiguration('apliarteAi');
    const currentModelsDir = cfg.get<string>('modelsDir', '').trim();

    const label = currentModelsDir || context.globalStorageUri.fsPath;
    const title = isFirstRun
      ? `ApliArte AI v${currentVersion} instalado — ¿Dónde guardas tus modelos de IA?`
      : `ApliArte AI actualizado a v${currentVersion} — ¿Sigue siendo esta tu carpeta de modelos?`;

    void vscode.window.showInformationMessage(
      `${title}\n📁 ${label}`,
      'Cambiar carpeta',
      'Está bien',
    ).then(async (pick) => {
      if (pick === 'Cambiar carpeta') {
        const result = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Usar esta carpeta para modelos',
          title: 'Elegir carpeta de modelos de IA',
        });
        if (result?.[0]) {
          await cfg.update('modelsDir', result[0].fsPath, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Carpeta de modelos actualizada: ${result[0].fsPath}`);
        }
      }
    });
  }

  // ── Comando: elegir carpeta de modelos ─────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.chooseModelsDir', async () => {
      const cfg = vscode.workspace.getConfiguration('apliarteAi');
      const result = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Usar esta carpeta para modelos',
        title: 'Elegir carpeta de modelos de IA',
        defaultUri: (() => {
          const current = cfg.get<string>('modelsDir', '').trim();
          return current ? vscode.Uri.file(current) : context.globalStorageUri;
        })(),
      });
      if (result?.[0]) {
        await cfg.update('modelsDir', result[0].fsPath, vscode.ConfigurationTarget.Global);
        const count = scanModelsDir(result[0].fsPath).length;
        vscode.window.showInformationMessage(
          `Carpeta de modelos: ${result[0].fsPath}${count > 0 ? ` — ${count} modelo(s) encontrado(s)` : ''}`
        );
      }
    })
  );

  // ── MCP: server manager + registry ─────────────────────
  _mcpManager = new McpServerManager({ name: 'apliarte-ai', version: context.extension.packageJSON.version ?? '0.0.0' });
  getToolRegistry().setServerManager(_mcpManager);
  getMcpResourceRegistry().setServerManager(_mcpManager);

  const syncMcpServers = async (): Promise<void> => {
    const mgr = _mcpManager;
    if (!mgr) return;
    const cfg = vscode.workspace.getConfiguration('apliarteAi');
    const configs = { ...cfg.get<Record<string, McpServerConfig>>('mcpServers', {}) };

    // Backwards compat: if the user has `engramEndpoint` set but no explicit
    // `engram` entry in mcpServers, inject one automatically. Keeps v0.6.x
    // configs working without manual migration.
    if (!configs.engram) {
      const engramUrl = cfg.get<string>('engramEndpoint', '').trim();
      if (engramUrl) {
        configs.engram = { transport: 'http', url: engramUrl };
      }
    }

    await mgr.sync(configs);
    await Promise.all([
      getToolRegistry().discoverAll(),
      getMcpResourceRegistry().discoverAll(),
    ]);
  };

  // Kick off the initial sync (fire-and-forget — logs errors internally).
  void syncMcpServers().catch((err) => logger.warn(`mcp sync failed: ${(err as Error).message}`));

  // Re-sync when the user edits mcpServers or the legacy engramEndpoint.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('apliarteAi.mcpServers') ||
        e.affectsConfiguration('apliarteAi.engramEndpoint')
      ) {
        void syncMcpServers().catch((err) => logger.warn(`mcp resync failed: ${(err as Error).message}`));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.showMcpStatus', async () => {
      const mgr = _mcpManager;
      if (!mgr) return;
      const servers = mgr.list();
      if (servers.length === 0) {
        vscode.window.showInformationMessage(
          'No hay servidores MCP configurados. Agrega entradas en apliarteAi.mcpServers.'
        );
        return;
      }
      const icon = (s: typeof servers[number]): string => {
        switch (s.status) {
          case 'ready':    return '$(pass-filled)';
          case 'starting': return '$(sync~spin)';
          case 'error':    return '$(error)';
          case 'stopped':  return '$(circle-outline)';
        }
      };
      const tools = getToolRegistry().list();
      const perServer = new Map<string, number>();
      for (const t of tools) {
        if (t.source.kind === 'mcp') {
          perServer.set(t.source.server, (perServer.get(t.source.server) ?? 0) + 1);
        }
      }
      const items = servers.map((s) => ({
        label: `${icon(s)} ${s.name}`,
        description: `${s.status}${s.error ? ' — ' + s.error : ''}`,
        detail: [
          s.serverInfo?.name ? `server: ${s.serverInfo.name} ${s.serverInfo.version ?? ''}` : undefined,
          s.status === 'ready' ? `tools: ${perServer.get(s.name) ?? 0}` : undefined,
        ].filter(Boolean).join(' · '),
      }));
      await vscode.window.showQuickPick(items, { placeHolder: 'Estado de servidores MCP' });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.restartMcpServer', async () => {
      const mgr = _mcpManager;
      if (!mgr) return;
      const servers = mgr.list();
      if (servers.length === 0) {
        vscode.window.showInformationMessage('No hay servidores MCP configurados.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        servers.map((s) => ({ label: s.name, description: `${s.status}${s.error ? ' — ' + s.error : ''}` })),
        { placeHolder: 'Reiniciar servidor MCP' },
      );
      if (!pick) return;
      await mgr.restart(pick.label);
      await getToolRegistry().discoverFromServer(pick.label);
    })
  );

  // ── Chat panel ─────────────────────────────────────────
  const chatProvider = new ChatViewProvider(context.extensionUri, context.globalState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider)
  );

  // Notify webview when models folder changes (chooseModelsDir command or manual edit)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('apliarteAi.modelsDir')) {
        void chatProvider.refreshAfterSettingsChange();
      }
    })
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
        vscode.window.showWarningMessage('Selecciona al menos un archivo del workspace.');
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
          'No se detectó LM Studio ni Ollama. Asegúrate de tener uno corriendo.'
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

  // ── Agent: Index workspace ─────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('apliarteAi.indexWorkspace', async () => {
      const config = vscode.workspace.getConfiguration('apliarteAi');
      const endpoint = config.get<string>('agentEndpoint', '');
      const apiKey = config.get<string>('agentApiKey', '');

      if (!endpoint || !apiKey) {
        vscode.window.showWarningMessage(
          'Configura apliarteAi.agentEndpoint y apliarteAi.agentApiKey en Settings.'
        );
        return;
      }

      const folders = vscode.workspace.workspaceFolders;
      if (!folders) {
        vscode.window.showWarningMessage('No hay workspace abierto.');
        return;
      }

      const workspaceId = Buffer.from(folders[0].uri.fsPath).toString('base64url').slice(0, 32);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'ApliArte AI: Indexando workspace…' },
        async (progress) => {
          progress.report({ message: 'Recolectando archivos…' });
          const files = await collectWorkspaceFiles();
          progress.report({ message: `Enviando ${files.length} archivos al agente…` });

          try {
            const result = await indexWorkspace(endpoint, apiKey, workspaceId, files);
            vscode.window.showInformationMessage(
              `Workspace indexado: ${result.indexed} archivos. @codebase listo.`
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Error indexando: ${msg}`);
          }
        }
      );
    })
  );

  // ── RAG: auto-index on open + incremental on save ─────────
  const getAgentConfig = (): { endpoint: string; apiKey: string; workspaceId: string } | null => {
    const cfg = vscode.workspace.getConfiguration('apliarteAi');
    const endpoint = cfg.get<string>('agentEndpoint', '').trim();
    const apiKey   = cfg.get<string>('agentApiKey', '').trim();
    const folders  = vscode.workspace.workspaceFolders;
    if (!endpoint || !apiKey || !folders) return null;
    const workspaceId = Buffer.from(folders[0].uri.fsPath).toString('base64url').slice(0, 32);
    return { endpoint, apiKey, workspaceId };
  };

  // Background full-workspace index (silent — no blocking UI)
  const autoIndexWorkspace = async (): Promise<void> => {
    const agent = getAgentConfig();
    if (!agent) return;
    try {
      const files = await collectWorkspaceFiles();
      if (files.length === 0) return;
      const dispose = vscode.window.setStatusBarMessage(
        `$(sync~spin) ApliArte AI: indexando ${files.length} archivos…`
      );
      const result = await indexWorkspace(agent.endpoint, agent.apiKey, agent.workspaceId, files);
      dispose.dispose();
      vscode.window.setStatusBarMessage(
        `$(check) ApliArte AI: @codebase listo (${result.indexed} archivos)`, 5000
      );
      logger.info(`Auto-index: ${result.indexed} archivos indexados`);
    } catch (err) {
      logger.warn(`Auto-index failed: ${(err as Error).message}`);
    }
  };

  // Incremental re-index on file save (debounced 3s)
  let _saveDebounce: ReturnType<typeof setTimeout> | undefined;
  const pendingSaves = new Set<string>();

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const agent = getAgentConfig();
      if (!agent) return;
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) return;
      const root = folders[0].uri.fsPath;
      if (!doc.uri.fsPath.startsWith(root)) return;

      const relativePath = doc.uri.fsPath.slice(root.length + 1);
      // Skip generated/vendor files
      if (/node_modules|\.git|dist\/|out\//.test(relativePath)) return;

      pendingSaves.add(relativePath);

      if (_saveDebounce) clearTimeout(_saveDebounce);
      _saveDebounce = setTimeout(async () => {
        const paths = [...pendingSaves];
        pendingSaves.clear();
        _saveDebounce = undefined;

        try {
          const files: Array<{ path: string; content: string }> = [];
          for (const p of paths) {
            try {
              const uri = vscode.Uri.joinPath(folders[0].uri, p);
              const bytes = await vscode.workspace.fs.readFile(uri);
              const content = Buffer.from(bytes).toString('utf-8');
              // Skip very large or binary files
              if (content.length < 500_000 && content.length > 0) {
                files.push({ path: p, content });
              }
            } catch { /* skip unreadable */ }
          }
          if (files.length === 0) return;
          await indexWorkspace(agent.endpoint, agent.apiKey, agent.workspaceId, files);
          logger.info(`Incremental index: ${files.length} file(s)`);
        } catch (err) {
          logger.warn(`Incremental index failed: ${(err as Error).message}`);
        }
      }, 3000);
    })
  );

  // Kick off auto-index on activation (fire-and-forget, silent on error)
  void autoIndexWorkspace().catch(() => { /* already logged inside */ });

  logger.info('ApliArte AI activado correctamente.');
}

export function deactivate(): void {
  _mcpManager?.dispose();
  _mcpManager = undefined;
  logger.info('ApliArte AI desactivado.');
}
