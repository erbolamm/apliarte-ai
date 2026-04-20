import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import {
  streamChat,
  streamChatWithTools,
  listModels,
  checkConnection,
  type ChatMessage,
  type ToolDescriptor,
  type InferenceStats,
} from '../core/llmService';
import {
  loadModel,
  streamChatLocal,
  listLocalModels,
  isModelLoaded,
  getLoadedModel,
  AVAILABLE_MODELS,
  unloadModel,
  areDepsInstalled,
  installDeps,
  scanModelsDirTyped,
} from '../core/localInference';
import {
  streamAgentChat,
  continueAfterToolCall,
  checkAgentConnection,
} from '../core/agentService';
import { executeTool } from '../tools/executor';
import { getToolRegistry } from '../mcp/toolRegistry';
import { getMcpResourceRegistry } from '../mcp/resourceRegistry';
import { ConversationStore } from '../core/conversationStore';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'apliarteAi.chatView';

  private _view?: vscode.WebviewView;
  private _history: ChatMessage[] = [];
  private _abortController?: AbortController;
  private _currentModel?: string;
  private _temperature = 0.7;
  private _contextText?: string;
  private _contextName?: string;
  private _provider: 'remote' | 'local' | 'agent' = 'remote';
  private _remoteEndpoint?: string;
  private _globalState: vscode.Memento;
  private _store: ConversationStore;
  private _activeConvId?: string;
  private _mcpSub?: vscode.Disposable;
  private readonly _tpsBar: vscode.StatusBarItem;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    globalState: vscode.Memento,
  ) {
    this._globalState = globalState;
    this._store = new ConversationStore(globalState);
    this._tpsBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this._tpsBar.tooltip = 'ApliArte AI — velocidad de inferencia local';
    // Migrate legacy flat history if it exists
    this._migrateLegacyHistory();
  }

  private async _migrateLegacyHistory(): Promise<void> {
    const legacy = this._globalState.get<ChatMessage[]>('chatHistory', []);
    if (legacy.length > 0) {
      const conv = await this._store.createConversation(this._provider, this._currentModel ?? '');
      await this._store.saveMessages(conv.id, legacy, this._provider, this._currentModel ?? '');
      await this._globalState.update('chatHistory', undefined);
      logger.info(`Migrated ${legacy.length} legacy messages to conversation ${conv.id}`);
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    // Subscribe to MCP status changes so badges update live.
    const mgr = getToolRegistry().getServerManager();
    if (mgr) {
      this._mcpSub?.dispose();
      this._mcpSub = mgr.onDidChange(() => {
        this._sendMcpStatus();
        // Discovery runs async after 'ready'; re-push shortly after so tool counts refresh.
        setTimeout(() => this._sendMcpStatus(), 800);
      });
      webviewView.onDidDispose(() => {
        this._mcpSub?.dispose();
        this._mcpSub = undefined;
      });
    }

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        // ── Init ──────────────────────────────────────────────────────────
        case 'webviewReady':
          await this._onWebviewReady();
          break;

        // ── Chat ──────────────────────────────────────────────────────────
        case 'sendMessage':
          await this._handleUserMessage(data.text);
          break;
        case 'stopGeneration':
          this._abortController?.abort();
          break;

        // ── Conversations ─────────────────────────────────────────────────
        case 'newConversation':
          await this._newConversation();
          break;
        case 'loadConversation':
          await this._loadConversation(data.id);
          break;
        case 'renameConversation':
          await this._renameConversation(data.id, data.title);
          break;
        case 'deleteConversation':
          await this._deleteConversation(data.id);
          break;
        case 'clearHistory':
          await this._clearCurrentConversation();
          break;
        case 'requestConversations':
          this._sendConversationList();
          break;

        // ── Export ────────────────────────────────────────────────────────
        case 'exportChat':
          await this._exportCurrentChat();
          break;
        case 'exportConversation':
          await this._exportConversation(data.id);
          break;
        case 'exportAll':
          await this._exportAllConversations();
          break;

        // ── Models ────────────────────────────────────────────────────────
        case 'requestModels':
          await this._refreshModels();
          break;
        case 'setModel':
          this._currentModel = data.model;
          break;
        case 'setProvider':
          await this._setProvider(data.provider);
          break;
        case 'downloadModel':
          await this._downloadLocalModel(data.model);
          break;
        case 'unloadModel':
          await unloadModel();
          this._post({ type: 'modelUnloaded' });
          break;

        // ── Settings ──────────────────────────────────────────────────────
        case 'getSettings':
          this._sendSettings();
          break;
        case 'saveSettings':
          await this._saveSettings(data.settings);
          break;
        case 'openVscodeSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'apliarteAi');
          break;

        case 'openUrl':
          if (data.url && typeof data.url === 'string') {
            void vscode.env.openExternal(vscode.Uri.parse(data.url));
          }
          break;

        case 'chooseModelsDir':
          void vscode.commands.executeCommand('apliarteAi.chooseModelsDir');
          break;

        case 'searchHfHub':
          await this._searchHuggingFaceHub(typeof data.query === 'string' ? data.query : '');
          break;

        case 'addMcpServer': {
          const { name: srvName, config: srvConfig } = data as { name: string; config: import('../mcp/types').McpServerConfig };
          if (!srvName) break;
          const cfg2 = vscode.workspace.getConfiguration('apliarteAi');
          const existingServers = { ...cfg2.get<Record<string, import('../mcp/types').McpServerConfig>>('mcpServers', {}) };
          existingServers[srvName] = srvConfig;
          await cfg2.update('mcpServers', existingServers, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Servidor MCP "${srvName}" agregado. Conectando…`);
          break;
        }

        case 'chooseMcpFolder': {
          const result = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: 'Usar esta carpeta para MCP Filesystem',
            title: 'Carpeta para el servidor MCP Filesystem',
          });
          if (result?.[0]) {
            const folderPath = result[0].fsPath;
            const cfg3 = vscode.workspace.getConfiguration('apliarteAi');
            const existingServers2 = { ...cfg3.get<Record<string, import('../mcp/types').McpServerConfig>>('mcpServers', {}) };
            existingServers2['filesystem'] = { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', folderPath] };
            await cfg3.update('mcpServers', existingServers2, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`MCP Filesystem configurado: ${folderPath}`);
          }
          break;
        }

        // ── MCP ──────────────────────────────────────────────────────────
        case 'requestMcpStatus':
          this._sendMcpStatus();
          break;

        case 'attachMcpResource': {
          const reg = getMcpResourceRegistry();
          const { server, uri, name: resName } = data as { server: string; uri: string; name: string };
          try {
            const contents = await reg.readResource(server, uri);
            const text = contents.map((c) => c.text ?? '').filter(Boolean).join('\n');
            if (text) this.attachContext(resName, text);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Error leyendo recurso MCP: ${msg}`);
          }
          break;
        }

        case 'invokeMcpPrompt': {
          const reg = getMcpResourceRegistry();
          const { server, promptName, args: promptArgs } = data as { server: string; promptName: string; args?: Record<string, string> };
          try {
            const result = await reg.getPrompt(server, promptName, promptArgs);
            const text = result.messages
              .map((m) => (m.content.type === 'text' ? m.content.text : ''))
              .filter(Boolean)
              .join('\n\n');
            if (text) this.attachContext(`Prompt: ${promptName}`, text);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Error obteniendo prompt MCP: ${msg}`);
          }
          break;
        }

        // ── Context ───────────────────────────────────────────────────────
        case 'insertCode':
          await this._insertCode(data.code);
          break;
        case 'applyDiff':
          await this._applyDiff(data.code);
          break;
        case 'requestAlternative':
          await this._generateAlternative(data.code as string, data.blockIdx as number);
          break;
        case 'requestContext':
          await this._attachEditorContext(data.scope);
          break;
        case 'removeContext':
          this._contextText = undefined;
          this._contextName = undefined;
          break;

        // ── Misc ──────────────────────────────────────────────────────────
        case 'setTemperature':
          this._temperature = data.value;
          break;
        case 'checkConnection':
          await this._sendConnectionStatus();
          break;
      }
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  private async _onWebviewReady(): Promise<void> {
    // Restore active conversation
    const conv = await this._store.getOrCreateActive(this._provider, this._currentModel ?? '');
    this._activeConvId = conv.id;
    this._history = conv.messages;

    if (this._history.length > 0) {
      this._post({ type: 'restoreHistory', messages: this._history });
    }

    this._sendConversationList();
    await this._refreshModels();
    await this._sendConnectionStatus();
    this._sendMcpStatus();
    this._sendSettings();
  }

  private _sendMcpStatus(): void {
    const mgr = getToolRegistry().getServerManager();
    if (!mgr) return;
    const servers = mgr.list();
    const allTools = getToolRegistry().list();
    const perServer = new Map<string, { name: string; description?: string }[]>();
    for (const t of allTools) {
      if (t.source.kind === 'mcp') {
        const list = perServer.get(t.source.server) ?? [];
        list.push({ name: t.source.originalName, description: t.description });
        perServer.set(t.source.server, list);
      }
    }
    const resourceReg = getMcpResourceRegistry();
    const allResources = resourceReg.listResources();
    const allPrompts = resourceReg.listPrompts();

    const payload = servers.map((s) => {
      const tools = perServer.get(s.name) ?? [];
      const resources = allResources
        .filter((r) => r.server === s.name)
        .map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType }));
      const prompts = allPrompts
        .filter((p) => p.server === s.name)
        .map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
      return {
        name: s.name,
        status: s.status,
        error: s.error,
        toolCount: tools.length,
        serverInfo: s.serverInfo,
        tools,
        resources,
        prompts,
      };
    });
    this._post({ type: 'mcpStatus', servers: payload });
  }

  // ── Conversation management ────────────────────────────────────────────────

  private async _newConversation(): Promise<void> {
    const conv = await this._store.createConversation(this._provider, this._currentModel ?? '');
    this._activeConvId = conv.id;
    this._history = [];
    this._contextText = undefined;
    this._contextName = undefined;
    this._post({ type: 'cleared' });
    this._post({ type: 'contextRemoved' });
    this._sendConversationList();
  }

  private async _loadConversation(id: string): Promise<void> {
    const conv = await this._store.getConversation(id);
    if (!conv) return;
    this._activeConvId = conv.id;
    this._history = conv.messages;
    await this._store.setActiveId(id);
    this._post({ type: 'cleared' });
    if (conv.messages.length > 0) {
      this._post({ type: 'restoreHistory', messages: conv.messages });
    }
    this._sendConversationList();
  }

  private async _renameConversation(id: string, title: string): Promise<void> {
    await this._store.renameConversation(id, title);
    this._sendConversationList();
  }

  private async _deleteConversation(id: string): Promise<void> {
    await this._store.deleteConversation(id);
    // If deleting the active one, start fresh
    if (id === this._activeConvId) {
      const convs = this._store.listConversations();
      if (convs.length > 0) {
        await this._loadConversation(convs[0].id);
      } else {
        await this._newConversation();
      }
    } else {
      this._sendConversationList();
    }
  }

  private async _clearCurrentConversation(): Promise<void> {
    this._history = [];
    if (this._activeConvId) {
      await this._store.saveMessages(this._activeConvId, [], this._provider, this._currentModel ?? '');
    }
    this._post({ type: 'cleared' });
    this._sendConversationList();
  }

  private _sendConversationList(): void {
    const list = this._store.listConversations();
    const activeId = this._activeConvId ?? this._store.getActiveId();
    this._post({ type: 'conversationList', conversations: list, activeId });
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  private async _exportCurrentChat(): Promise<void> {
    if (!this._activeConvId) return;
    await this._exportConversation(this._activeConvId);
  }

  private async _exportConversation(id: string): Promise<void> {
    const md = await this._store.exportToMarkdown(id);
    if (!md) return;
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc);
  }

  private async _exportAllConversations(): Promise<void> {
    const md = await this._store.exportAllToMarkdown();
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc);
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  private _sendSettings(): void {
    const cfg = vscode.workspace.getConfiguration('apliarteAi');
    this._post({
      type: 'settingsLoaded',
      settings: {
        preset:           cfg.get<string>('preset', 'minimal'),
        lmstudioEndpoint: cfg.get<string>('lmstudioEndpoint', 'http://localhost:1234/v1'),
        ollamaEndpoint:   cfg.get<string>('ollamaEndpoint', 'http://localhost:11434'),
        agentEndpoint:    cfg.get<string>('agentEndpoint', ''),
        agentApiKey:      cfg.get<string>('agentApiKey', ''),
        language:         cfg.get<string>('language', 'es'),
        modelsDir:        cfg.get<string>('modelsDir', ''),
      },
    });
  }

  private async _saveSettings(settings: Record<string, string>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('apliarteAi');
    const target = vscode.ConfigurationTarget.Global;

    if ('preset' in settings)           await cfg.update('preset', settings.preset, target);
    if ('lmstudioEndpoint' in settings) await cfg.update('lmstudioEndpoint', settings.lmstudioEndpoint, target);
    if ('ollamaEndpoint' in settings)   await cfg.update('ollamaEndpoint', settings.ollamaEndpoint, target);
    if ('agentEndpoint' in settings)    await cfg.update('agentEndpoint', settings.agentEndpoint, target);
    if ('agentApiKey' in settings)      await cfg.update('agentApiKey', settings.agentApiKey, target);
    if ('language' in settings)         await cfg.update('language', settings.language, target);
    if ('modelsDir' in settings)        await cfg.update('modelsDir', settings.modelsDir, target);

    // Reset caches that depend on config
    this._remoteEndpoint = undefined;

    this._post({ type: 'settingsSaved' });
    vscode.window.showInformationMessage('ApliArte AI: Configuración guardada.');
    await this._sendConnectionStatus();
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  private async _setProvider(provider: 'remote' | 'local' | 'agent'): Promise<void> {
    this._provider = provider;
    this._currentModel = undefined;
    this._remoteEndpoint = undefined;
    // No auto-descargamos el modelo al cambiar de proveedor — el usuario
    // lo hace explícitamente desde el botón o el selector de modelos.
    // Sí pre-instalamos las deps en background sin UI bloqueante.
    if (provider === 'local' && !areDepsInstalled()) {
      // Fire-and-forget: instala deps sin bloquear la UI ni tocar la barra
      installDeps().catch((e) => logger.error(`Deps pre-install: ${e}`));
    }
    await this._refreshModels();
    await this._sendConnectionStatus();
  }

  private async _handleUserMessage(text: string): Promise<void> {
    if (!this._view) return;

    // Ensure active conversation
    if (!this._activeConvId) {
      const conv = await this._store.createConversation(this._provider, this._currentModel ?? '');
      this._activeConvId = conv.id;
    }

    const config = vscode.workspace.getConfiguration('apliarteAi');

    if (!this._currentModel && this._provider !== 'agent') {
      await this._refreshModels();
    }
    if (!this._currentModel && this._provider !== 'agent') {
      if (this._provider === 'local') {
        const recommended = AVAILABLE_MODELS.find((m) => m.recommended) ?? AVAILABLE_MODELS[0];
        if (recommended) {
          this._post({ type: 'responseStart' });
          this._post({
            type: 'responseChunk',
            text: `Descargando modelo **${recommended.label}** (${recommended.size})... Esto solo pasa la primera vez.\n\n`,
          });
          try {
            await this._downloadLocalModel(recommended.id);
            this._post({ type: 'responseEnd' });
          } catch {
            this._post({ type: 'responseError', text: 'Error descargando el modelo. Seleccioná uno manualmente.' });
            return;
          }
        } else {
          this._post({ type: 'responseError', text: 'No hay modelos locales disponibles.' });
          return;
        }
      } else {
        this._post({ type: 'responseError', text: 'No hay modelo cargado. Abrí LM Studio u Ollama, cargá un modelo, y volvé a intentar.' });
        return;
      }
    }

    let content = text;
    if (this._contextText) {
      content = `[Contexto: ${this._contextName}]\n\`\`\`\n${this._contextText}\n\`\`\`\n\n${text}`;
      this._contextText = undefined;
      this._contextName = undefined;
      this._post({ type: 'contextRemoved' });
    }

    this._history.push({ role: 'user', content });

    const preset = config.get<string>('preset', 'minimal');
    const systemPrompt = this._getSystemPrompt(preset);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this._history,
    ];

    this._post({ type: 'responseStart' });
    this._abortController = new AbortController();

    try {
      let fullResponse = '';

      if (this._provider === 'agent') {
        fullResponse = await this._handleAgentChat(config, messages);
      } else if (this._provider === 'local') {
        // Small local models don't support tool-calling — show hint if tools are configured.
        if (getToolRegistry().list().length > 0) {
          const hint = '_Nota: herramientas MCP no disponibles en modo Local._\n\n';
          fullResponse += hint;
          this._post({ type: 'responseChunk', text: hint });
        }
        await streamChatLocal(messages, (chunk: string) => {
          fullResponse += chunk;
          this._post({ type: 'responseChunk', text: chunk });
        }, {
          signal: this._abortController.signal,
          temperature: this._temperature,
          onStats: (stats) => this._handleInferenceStats(stats),
        });
      } else {
        fullResponse = await this._handleRemoteChat(messages);
      }

      this._history.push({ role: 'assistant', content: fullResponse });
      await this._store.saveMessages(
        this._activeConvId!,
        this._history,
        this._provider,
        this._currentModel ?? ''
      );
      this._sendConversationList();
      this._post({ type: 'responseEnd' });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this._post({ type: 'responseStopped' });
        return;
      }
      const msg = error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Chat error: ${msg}`);
      this._post({ type: 'responseError', text: msg });
      this._history.pop();
      await this._store.saveMessages(
        this._activeConvId!,
        this._history,
        this._provider,
        this._currentModel ?? ''
      );
    } finally {
      this._abortController = undefined;
    }
  }

  private async _handleAgentChat(
    config: vscode.WorkspaceConfiguration,
    messages: ChatMessage[]
  ): Promise<string> {
    const endpoint = config.get<string>('agentEndpoint', '');
    const apiKey   = config.get<string>('agentApiKey', '');

    if (!endpoint) throw new Error('Configurá apliarteAi.agentEndpoint en Settings.');
    if (!apiKey)   throw new Error('Configurá apliarteAi.agentApiKey en Settings.');

    const folders = vscode.workspace.workspaceFolders;
    const workspaceId = folders?.[0]
      ? Buffer.from(folders[0].uri.fsPath).toString('base64url').slice(0, 32)
      : undefined;

    let fullResponse = '';
    let currentMessages = [...messages];
    const MAX_TOOL_ITERATIONS = 10;

    // Build the tools[] list for the LLM from the shared registry
    // (built-ins + MCP-discovered tools). Empty if no MCP servers configured.
    const registryTools = getToolRegistry().list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const isFirstCall = iteration === 0;
      const stream = isFirstCall
        ? streamAgentChat(endpoint, apiKey, currentMessages, {
            signal: this._abortController?.signal,
            temperature: this._temperature,
            workspaceId,
            tools: registryTools,
          })
        : continueAfterToolCall(endpoint, apiKey, currentMessages, {
            signal: this._abortController?.signal,
            temperature: this._temperature,
            workspaceId,
            tools: registryTools,
          });

      let gotToolCall = false;

      for await (const event of stream) {
        switch (event.type) {
          case 'chunk':
            fullResponse += event.text ?? '';
            this._post({ type: 'responseChunk', text: event.text });
            break;

          case 'tool_call': {
            gotToolCall = true;
            const tc = event.toolCall!;
            this._post({ type: 'toolCallBlock', id: tc.id, name: tc.name, args: tc.arguments, status: 'running' });

            const result = await executeTool(tc);

            currentMessages.push({
              role: 'assistant',
              content: '',
              // @ts-expect-error — tool_calls field for OpenAI protocol
              tool_calls: [{
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              }],
            });
            currentMessages.push({
              role: 'tool' as 'user',
              content: result.content,
              // @ts-expect-error — tool_call_id field for OpenAI protocol
              tool_call_id: tc.id,
            });

            this._post({ type: 'toolCallBlock', id: tc.id, name: tc.name, result: result.content, status: 'done' });
            break;
          }

          case 'error':
            throw new Error(event.text ?? 'Error del agente');

          case 'done':
            return fullResponse;
        }
      }

      if (!gotToolCall) break;
    }

    return fullResponse;
  }

  private async _handleRemoteChat(messages: ChatMessage[]): Promise<string> {
    const endpoint = await this._resolveRemoteEndpoint();

    const registryTools: ToolDescriptor[] = getToolRegistry().list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    // No tools configured → fall back to plain streaming (avoids sending empty tools[])
    if (registryTools.length === 0) {
      let fullResponse = '';
      await streamChat(endpoint, messages, (chunk: string) => {
        fullResponse += chunk;
        this._post({ type: 'responseChunk', text: chunk });
      }, {
        signal: this._abortController?.signal,
        temperature: this._temperature,
        model: this._currentModel,
        timeoutMs: 60_000,
      });
      return fullResponse;
    }

    let fullResponse = '';
    let currentMessages = [...messages];
    const MAX_TOOL_ITERATIONS = 10;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      let gotToolCall = false;

      for await (const event of streamChatWithTools(endpoint, currentMessages, registryTools, {
        signal: this._abortController?.signal,
        temperature: this._temperature,
        model: this._currentModel,
        timeoutMs: 60_000,
      })) {
        switch (event.type) {
          case 'chunk':
            fullResponse += event.text ?? '';
            this._post({ type: 'responseChunk', text: event.text });
            break;

          case 'tool_call': {
            gotToolCall = true;
            const tc = event.toolCall!;
            this._post({ type: 'toolCallBlock', id: tc.id, name: tc.name, args: tc.arguments, status: 'running' });

            const result = await getToolRegistry().execute(tc.name, tc.arguments);

            currentMessages.push({
              role: 'assistant',
              content: '',
              // @ts-expect-error — tool_calls field for OpenAI protocol
              tool_calls: [{
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              }],
            });
            currentMessages.push({
              role: 'tool' as 'user',
              content: result,
              // @ts-expect-error — tool_call_id for OpenAI protocol
              tool_call_id: tc.id,
            });

            this._post({ type: 'toolCallBlock', id: tc.id, name: tc.name, result, status: 'done' });
            break;
          }

          case 'error':
            throw new Error(event.text ?? 'Error en LM Studio/Ollama');

          case 'done':
            return fullResponse;
        }
      }

      if (!gotToolCall) break;
    }

    return fullResponse;
  }

  // ── Models / Connection ────────────────────────────────────────────────────

  private async _refreshModels(): Promise<void> {
    if (this._provider === 'agent') {
      this._post({
        type: 'modelsLoaded',
        models: ['agent-default'],
        selected: 'agent-default',
        agentMode: true,
      });
      return;
    }

    if (this._provider === 'local') {
      const cfg = vscode.workspace.getConfiguration('apliarteAi');
      const modelsDir = cfg.get<string>('modelsDir', '').trim();
      const allModels = await listLocalModels();
      const loaded = getLoadedModel();
      this._currentModel = loaded ?? undefined;

      // Typed scan: split ONNX (loadable) vs GGUF (informational — needs LM Studio)
      const catalogIds = new Set(AVAILABLE_MODELS.map((m) => m.id));
      const scanned = modelsDir ? scanModelsDirTyped(modelsDir) : [];
      const scannedOnnx = scanned
        .filter((m) => m.type === 'onnx' && !catalogIds.has(m.id))
        .map((m) => m.id);
      const scannedGguf = scanned
        .filter((m) => m.type === 'gguf')
        .map((m) => m.id);

      this._post({
        type: 'modelsLoaded',
        models: allModels.map((m) => m.id),
        selected: this._currentModel ?? '',
        localCatalog: AVAILABLE_MODELS,
        scannedModels: scannedOnnx,
        ggufModels: scannedGguf,
        loadedModel: loaded,
        needsModelsDir: !modelsDir,
        modelsDir,
      });
      return;
    }

    const endpoint = await this._resolveRemoteEndpoint();

    for (let attempt = 0; attempt < 2; attempt++) {
      const models = await listModels(endpoint);
      if (models.length > 0) {
        if (!this._currentModel) {
          this._currentModel = models[0].id;
        }
        this._post({ type: 'modelsLoaded', models: models.map((m) => m.id), selected: this._currentModel });
        return;
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    this._post({ type: 'modelsLoaded', models: [], selected: '' });
  }

  private _tpsBarTimer?: ReturnType<typeof setTimeout>;

  private _handleInferenceStats(stats: InferenceStats): void {
    const tps = stats.tokensPerSecond;
    const icon = tps >= 8 ? '$(zap)' : tps >= 4 ? '$(warning)' : '$(error)';
    this._tpsBar.text = `${icon} ${tps.toFixed(1)} t/s`;
    this._tpsBar.show();

    clearTimeout(this._tpsBarTimer);
    this._tpsBarTimer = setTimeout(() => this._tpsBar.hide(), 8000);

    // Find fastest available catalog model smaller than current
    const catalog = AVAILABLE_MODELS;
    const currentIdx = catalog.findIndex((m) => m.id === stats.model);
    const suggestedModel = currentIdx > 0 ? catalog[currentIdx - 1].id : undefined;

    this._post({ type: 'inferenceStats', tokensPerSecond: tps, suggestedModel });
  }

  private async _sendConnectionStatus(): Promise<void> {
    if (this._provider === 'agent') {
      const config = vscode.workspace.getConfiguration('apliarteAi');
      const endpoint = config.get<string>('agentEndpoint', '');
      const apiKey   = config.get<string>('agentApiKey', '');
      if (!endpoint || !apiKey) {
        this._post({ type: 'connectionStatus', connected: false, provider: 'agent' });
        return;
      }
      const connected = await checkAgentConnection(endpoint, apiKey);
      this._post({ type: 'connectionStatus', connected, provider: 'agent' });
      return;
    }
    if (this._provider === 'local') {
      const loaded = isModelLoaded();
      this._post({ type: 'connectionStatus', connected: loaded, provider: 'local' });
      return;
    }
    const endpoint = await this._resolveRemoteEndpoint();
    const connected = await checkConnection(endpoint);
    const name = endpoint.includes('11434') ? 'Ollama' : 'LM Studio';
    this._post({ type: 'connectionStatus', connected, provider: 'remote', name });
  }

  /**
   * Instala @huggingface/transformers en el directorio de deps.
   * Sólo emite progreso si `onProgress` se provee — NO manipula la barra de descarga
   * del modelo directamente para no cortar el ciclo downloadStart/Complete del llamador.
   */
  private async _ensureLocalDeps(onProgress?: (msg: string) => void): Promise<void> {
    if (areDepsInstalled()) return;
    try {
      await installDeps((msg) => onProgress?.(msg));
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Error instalando dependencias';
      throw new Error(`No se pudieron instalar las dependencias: ${msg}`);
    }
  }

  private async _resolveRemoteEndpoint(): Promise<string> {
    if (this._remoteEndpoint) return this._remoteEndpoint;

    const config    = vscode.workspace.getConfiguration('apliarteAi');
    const lmstudio  = config.get<string>('lmstudioEndpoint', 'http://localhost:1234/v1');
    const ollama    = config.get<string>('ollamaEndpoint', 'http://localhost:11434');
    const ollamaV1  = `${ollama.replace(/\/+$/, '')}/v1`;

    const results = await Promise.allSettled([
      checkConnection(lmstudio),
      checkConnection(ollamaV1),
    ]);

    const lmOk     = results[0].status === 'fulfilled' && results[0].value;
    const ollamaOk = results[1].status === 'fulfilled' && results[1].value;

    if (lmOk) {
      this._remoteEndpoint = lmstudio;
    } else if (ollamaOk) {
      this._remoteEndpoint = ollamaV1;
    } else {
      this._remoteEndpoint = lmstudio;
    }
    return this._remoteEndpoint;
  }

  /**
   * Descarga (o carga desde caché) un modelo local.
   * Esta función es la ÚNICA propietaria del ciclo downloadStart → Progress → Complete/Error.
   * Las deps se instalan aquí dentro, con progreso embebido en la misma barra.
   */
  private async _downloadLocalModel(modelId: string): Promise<void> {
    const label = AVAILABLE_MODELS.find((m) => m.id === modelId)?.label ?? modelId.split('/').pop() ?? modelId;
    this._post({ type: 'downloadStart', model: modelId });
    try {
      // Fase 1: instalar transformers.js si es la primera vez
      if (!areDepsInstalled()) {
        this._post({
          type: 'downloadProgress', status: 'progress', model: modelId,
          file: 'Primera vez — instalando motor de inferencia…', progress: 2,
        });
        await this._ensureLocalDeps((msg) => {
          this._post({
            type: 'downloadProgress', status: 'progress', model: modelId,
            file: msg.slice(0, 60), progress: 5,
          });
        });
        this._post({
          type: 'downloadProgress', status: 'progress', model: modelId,
          file: `Descargando ${label}…`, progress: 10,
        });
      }

      // Fase 2: cargar/descargar el modelo con progreso real de transformers.js
      await loadModel(modelId, (info) => {
        // Remap progress de [0-100] a [10-100] para dejamos espacio a la fase 1
        const p = typeof info.progress === 'number'
          ? Math.round(10 + info.progress * 0.9)
          : undefined;
        this._post({ type: 'downloadProgress', ...info, progress: p, model: modelId });
      });

      this._currentModel = modelId;
      this._post({ type: 'downloadComplete', model: modelId });
      await this._refreshModels();
      await this._sendConnectionStatus();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Error descargando modelo';
      logger.error(`_downloadLocalModel: ${msg}`);
      this._post({ type: 'downloadError', text: msg, model: modelId });
      // Si las deps fallaron, volvemos a remote para no quedar en estado roto
      if (!areDepsInstalled()) this._provider = 'remote';
    }
  }

  private async _searchHuggingFaceHub(query: string): Promise<void> {
    try {
      const params = new URLSearchParams({
        filter: 'onnx',
        sort: 'downloads',
        direction: '-1',
        limit: '20',
      });
      if (query) params.set('search', query);
      const url = `https://huggingface.co/api/models?${params.toString()}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HF API error: ${res.status}`);
      const models = await res.json() as Array<{ modelId: string; downloads?: number; pipeline_tag?: string }>;
      this._post({ type: 'hfResults', models });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._post({ type: 'hfResults', models: [], error: msg });
    }
  }

  // ── Context ────────────────────────────────────────────────────────────────

  public async refreshAfterSettingsChange(): Promise<void> {
    this._sendSettings();
    if (this._provider === 'local') {
      await this._refreshModels();
      await this._sendConnectionStatus();
    }
  }

  public attachContext(name: string, text: string): void {
    this._contextText = text;
    this._contextName = name;
    this._post({ type: 'contextAttached', name, preview: text.slice(0, 200) });
  }

  public sendMessage(text: string): void {
    this._post({ type: 'autoSend', text });
  }

  private async _insertCode(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No hay editor activo para insertar código.');
      return;
    }
    await editor.edit((edit) => {
      edit.insert(editor.selection.active, code);
    });
    vscode.window.showInformationMessage('Código insertado.');
  }

  private async _generateAlternative(originalCode: string, blockIdx: number): Promise<void> {
    if (this._provider === 'local') {
      this._post({ type: 'alternativeError', blockIdx, error: 'Modo Local no soporta alternativas' });
      return;
    }

    this._post({ type: 'alternativeLoading', blockIdx });

    const prompt: ChatMessage = {
      role: 'user',
      content: `Generate one concise alternative implementation of the following code. Use a different approach or algorithm. Return ONLY the code block, no explanations.\n\n\`\`\`\n${originalCode}\n\`\`\``,
    };

    try {
      let fullAlt = '';
      const config = vscode.workspace.getConfiguration('apliarteAi');

      if (this._provider === 'agent') {
        const endpoint = config.get<string>('agentEndpoint', '');
        const apiKey = config.get<string>('agentApiKey', '');
        await streamChat(endpoint, [prompt], (chunk) => { fullAlt += chunk; }, {
          signal: undefined,
          temperature: 0.8,
          model: this._currentModel,
          timeoutMs: 30_000,
        });
        void apiKey; // unused here — agent mode uses agentEndpoint directly
      } else {
        const endpoint = this._remoteEndpoint ?? config.get<string>('lmstudioEndpoint', 'http://localhost:1234/v1');
        await streamChat(endpoint, [prompt], (chunk) => { fullAlt += chunk; }, {
          signal: undefined,
          temperature: 0.8,
          model: this._currentModel,
          timeoutMs: 30_000,
        });
      }

      // Extract code from fenced block if present
      const match = fullAlt.match(/```[\w]*\n?([\s\S]*?)```/);
      const altCode = match ? match[1].trim() : fullAlt.trim();
      this._post({ type: 'alternativeReady', blockIdx, code: altCode });
    } catch (err) {
      this._post({ type: 'alternativeError', blockIdx, error: (err as Error).message });
    }
  }

  private async _applyDiff(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No hay editor activo. Abrí el archivo donde querés aplicar el cambio.');
      return;
    }

    const originalUri     = editor.document.uri;
    const originalContent = editor.document.getText();
    const fileName        = editor.document.fileName.split('/').pop() ?? 'archivo';

    const proposedDoc = await vscode.workspace.openTextDocument({
      content:  code,
      language: editor.document.languageId,
    });

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedDoc.uri,
      `${fileName} ↔ Propuesta ApliArte AI`
    );

    const action = await vscode.window.showInformationMessage(
      '¿Querés aplicar estos cambios?',
      'Aplicar',
      'Cancelar'
    );

    if (action === 'Aplicar') {
      const edit      = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(originalContent.length)
      );
      edit.replace(originalUri, fullRange, code);
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage('Cambios aplicados.');
    }
  }

  private async _attachEditorContext(scope: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._post({ type: 'contextError', text: 'No hay editor activo.' });
      return;
    }
    if (scope === 'selection') {
      const sel = editor.document.getText(editor.selection);
      if (!sel) {
        this._post({ type: 'contextError', text: 'No hay texto seleccionado.' });
        return;
      }
      const name = `Selección (${editor.document.fileName.split('/').pop()})`;
      this.attachContext(name, sel);
    } else {
      const text = editor.document.getText();
      const name = editor.document.fileName.split('/').pop() ?? 'archivo';
      this.attachContext(name, text);
    }
  }

  // ── System prompts ─────────────────────────────────────────────────────────

  private _getSystemPrompt(preset: string): string {
    switch (preset) {
      case 'full-gentleman':
        return 'Eres un Senior Architect con 15+ años de experiencia, GDE & MVP. Responde SIEMPRE en español. Eres apasionado, directo, y te importa que la gente aprenda. CONCEPTS > CODE. Usa MAYÚSCULAS para énfasis. Si algo se puede hacer mejor, dilo.';
      case 'ecosystem-only':
        return 'Eres un arquitecto de software senior. Responde SIEMPRE en español. Sé directo, propone alternativas, explica el razonamiento técnico. Prioriza conceptos sobre código.';
      default:
        return 'Eres un asistente experto en programación. Responde SIEMPRE en español. Sé conciso y directo.';
    }
  }

  private _post(message: Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  // ---------------------------------------------------------------------------
  // HTML / CSS / JS
  // ---------------------------------------------------------------------------
  private _getHtml(webview: vscode.Webview): string {
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css')
    );
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
<style>
/* ── Reset ─────────────────────────────────────────────── */
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
  color:var(--vscode-foreground);background:var(--vscode-sideBar-background);
  display:flex;flex-direction:column;height:100vh;overflow:hidden;
}

/* ── Toolbar ───────────────────────────────────────────── */
#toolbar{
  display:flex;align-items:center;padding:5px 8px;gap:5px;
  border-bottom:1px solid var(--vscode-panel-border);
  background:var(--vscode-sideBar-background);
  position:sticky;top:0;z-index:10;flex-shrink:0;
}
#status{display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap;min-width:0;}
.dot{width:7px;height:7px;border-radius:50%;background:#ef4444;flex-shrink:0;}
.dot.on{background:#22c55e;box-shadow:0 0 6px #22c55e80;animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
#model-select{
  flex:1;min-width:0;max-width:160px;
  background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border);border-radius:4px;
  padding:2px 4px;font-size:11px;
}
#tps-badge{
  font-size:10px;padding:1px 5px;border-radius:3px;white-space:nowrap;
  background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
}
#tps-badge.tps-ok{background:#166534;color:#bbf7d0;}
#tps-badge.tps-warn{background:#92400e;color:#fde68a;}
#tps-badge.tps-slow{background:#7f1d1d;color:#fecaca;}
#slow-banner{
  display:flex;align-items:center;gap:6px;padding:5px 10px;
  background:var(--vscode-inputValidation-warningBackground,#451a03);
  border-top:1px solid var(--vscode-inputValidation-warningBorder,#d97706);
  font-size:11px;flex-shrink:0;
}
#slow-banner-text{flex:1;color:var(--vscode-foreground);}
#slow-banner-btn{
  font-size:10px;padding:2px 8px;border:none;border-radius:3px;cursor:pointer;
  background:var(--vscode-button-background);color:var(--vscode-button-foreground);white-space:nowrap;
}
.slow-banner-close{
  background:none;border:none;cursor:pointer;color:var(--vscode-foreground);opacity:.6;font-size:13px;padding:0 2px;
}
.slow-banner-close:hover{opacity:1;}
#provider-select{
  max-width:110px;min-width:80px;
  background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border);border-radius:4px;
  padding:2px 4px;font-size:11px;
}
.tb{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;
  font-size:14px;opacity:.55;padding:2px 4px;border-radius:3px;flex-shrink:0;}
.tb:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground);}
.tb.active{opacity:1;color:var(--vscode-button-background);}

/* ── MCP badges ───────────────────────────────────────── */
#mcp-badges{display:flex;align-items:center;gap:3px;flex-wrap:nowrap;min-width:0;}
.mcp-badge{
  font-size:9px;padding:1px 5px;border-radius:10px;
  background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
  white-space:nowrap;cursor:default;display:inline-flex;align-items:center;gap:3px;
  border:1px solid transparent;
}
.mcp-badge .mcp-dot{width:6px;height:6px;border-radius:50%;background:#9ca3af;flex-shrink:0;}
.mcp-badge.ready{background:#22c55e22;color:#22c55e;border-color:#22c55e44;}
.mcp-badge.ready .mcp-dot{background:#22c55e;box-shadow:0 0 4px #22c55e80;}
.mcp-badge.starting{background:#fbbf2422;color:#fbbf24;border-color:#fbbf2444;}
.mcp-badge.starting .mcp-dot{background:#fbbf24;animation:pulse 1.2s infinite;}
.mcp-badge.error{background:#ef444422;color:#ef4444;border-color:#ef444444;}
.mcp-badge.error .mcp-dot{background:#ef4444;}
.mcp-badge.stopped{opacity:.5;}
.mcp-badge{cursor:pointer;}
.mcp-badge:hover{filter:brightness(1.2);}

/* ── MCP panel (collapsible) ────────────────────────────── */
#mcp-panel{
  display:none;position:absolute;top:34px;right:8px;z-index:50;
  width:280px;max-height:60vh;overflow-y:auto;
  background:var(--vscode-editorWidget-background);
  border:1px solid var(--vscode-panel-border);border-radius:6px;
  box-shadow:0 4px 14px rgba(0,0,0,.25);padding:6px;
}
#mcp-panel.open{display:block;}
.mcp-panel-server{margin-bottom:8px;}
.mcp-panel-server-head{
  font-size:11px;font-weight:700;padding:4px 6px;
  display:flex;align-items:center;justify-content:space-between;
  border-bottom:1px solid var(--vscode-panel-border);
}
.mcp-panel-server-head .status-pill{
  font-size:9px;padding:1px 6px;border-radius:8px;
  background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
}
.mcp-panel-server-head .status-pill.ready{background:#22c55e22;color:#22c55e;}
.mcp-panel-server-head .status-pill.error{background:#ef444422;color:#ef4444;}
.mcp-panel-server-head .status-pill.starting{background:#fbbf2422;color:#fbbf24;}
.mcp-tool-row{
  padding:5px 6px;font-size:11px;border-radius:4px;
  display:flex;flex-direction:column;gap:1px;cursor:default;
}
.mcp-tool-row:hover{background:var(--vscode-list-hoverBackground);}
.mcp-tool-name{font-family:var(--vscode-editor-font-family);font-weight:600;}
.mcp-tool-desc{font-size:10px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mcp-panel-empty{padding:10px;font-size:11px;opacity:.5;text-align:center;font-style:italic;}
.mcp-panel-error{padding:4px 6px;font-size:10px;color:#ef4444;font-family:var(--vscode-editor-font-family);word-break:break-word;}
.mcp-section-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.4;padding:4px 8px 2px;}

/* ── Main layout ───────────────────────────────────────── */
#main{display:flex;flex:1;overflow:hidden;}

/* ── Sidebar (conversations) ───────────────────────────── */
#sidebar{
  width:220px;flex-shrink:0;
  border-right:1px solid var(--vscode-panel-border);
  display:flex;flex-direction:column;overflow:hidden;
  background:var(--vscode-sideBar-background);
  transition:width .2s ease;
}
#sidebar.collapsed{width:0;border-right:none;}
#sidebar-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:7px 10px 5px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;
}
#sidebar-head span{font-size:11px;font-weight:700;opacity:.6;text-transform:uppercase;letter-spacing:.5px;}
#new-conv-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);
  border:none;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;flex-shrink:0;}
#new-conv-btn:hover{filter:brightness(1.15);}
#conv-list{flex:1;overflow-y:auto;padding:4px;}

/* ── Conversation item ─────────────────────────────────── */
.conv-item{
  padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:2px;
  position:relative;transition:background .15s;
}
.conv-item:hover{background:var(--vscode-list-hoverBackground);}
.conv-item.active{background:var(--vscode-list-activeSelectionBackground);
  color:var(--vscode-list-activeSelectionForeground);}
.conv-title{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  padding-right:36px;}
.conv-meta{font-size:10px;opacity:.5;margin-top:2px;}
.conv-preview{font-size:10px;opacity:.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
.conv-actions{position:absolute;right:6px;top:50%;transform:translateY(-50%);
  display:none;gap:2px;align-items:center;}
.conv-item:hover .conv-actions,.conv-item.active .conv-actions{display:flex;}
.conv-act-btn{background:none;border:none;cursor:pointer;padding:2px 3px;border-radius:3px;
  color:var(--vscode-foreground);opacity:.55;font-size:12px;}
.conv-act-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground);}
.conv-act-btn.danger:hover{color:var(--vscode-errorForeground);opacity:1;}
#conv-empty{padding:20px 10px;text-align:center;font-size:11px;opacity:.4;font-style:italic;}

/* ── Chat area ─────────────────────────────────────────── */
#chat-area{display:flex;flex-direction:column;flex:1;overflow:hidden;}

/* ── Messages ──────────────────────────────────────────── */
#messages{flex:1;overflow-y:auto;scroll-behavior:smooth;}

/* ── Welcome ───────────────────────────────────────────── */
#welcome{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:32px 16px;text-align:center;animation:fadeUp .5s ease;height:100%;
}
#welcome .logo{font-size:44px;margin-bottom:8px;}
#welcome h2{font-size:16px;font-weight:700;margin-bottom:4px;}
#welcome .sub{font-size:11px;opacity:.5;margin-bottom:18px;}
.qa{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;}
.qa button{
  background:var(--vscode-button-secondaryBackground);
  color:var(--vscode-button-secondaryForeground);
  border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:11px;transition:all .2s;
}
.qa button:hover{filter:brightness(1.15);transform:translateY(-1px);}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

/* ── Message ───────────────────────────────────────────── */
.msg{padding:10px 12px;animation:msgIn .25s ease;border-bottom:1px solid var(--vscode-panel-border);}
.msg:last-child{border-bottom:none;}
@keyframes msgIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.msg.user{background:var(--vscode-input-background);}
.msg.assistant{background:transparent;}
.msg-hdr{display:flex;align-items:center;gap:5px;margin-bottom:5px;
  font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;opacity:.65;}
.msg.user .msg-hdr{color:var(--vscode-terminal-ansiCyan);}
.msg.assistant .msg-hdr{color:var(--vscode-terminal-ansiGreen);}
.msg-body{line-height:1.6;font-size:13px;word-wrap:break-word;}
.msg-body .line{margin:1px 0;}
.msg-body h1{font-size:17px;font-weight:700;margin:10px 0 4px;}
.msg-body h2{font-size:15px;font-weight:700;margin:8px 0 4px;}
.msg-body h3{font-size:13px;font-weight:700;margin:6px 0 3px;}
.msg-body strong{font-weight:700;}
.msg-body em{font-style:italic;}
.msg-body del{text-decoration:line-through;opacity:.6;}
.msg-body blockquote{border-left:3px solid var(--vscode-textBlockQuote-border);padding:3px 10px;margin:4px 0;opacity:.8;}
.msg-body .li{padding-left:14px;position:relative;}
.msg-body .li::before{content:'';position:absolute;left:4px;top:8px;width:4px;height:4px;border-radius:50%;background:var(--vscode-foreground);opacity:.45;}
.msg-body hr{border:none;border-top:1px solid var(--vscode-panel-border);margin:8px 0;}
code.il{background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:12px;}
.cb{margin:8px 0;border-radius:6px;overflow:hidden;border:1px solid var(--vscode-panel-border);}
.cb-head{display:flex;align-items:center;justify-content:space-between;padding:3px 10px;font-size:10px;background:color-mix(in srgb,var(--vscode-sideBar-background),#000 12%);}
.cb-lang{opacity:.55;font-family:var(--vscode-editor-font-family);}
.cb-acts{display:flex;gap:2px;}
.cb-acts button{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:10px;opacity:.5;padding:2px 6px;border-radius:3px;transition:all .15s;}
.cb-acts button:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground);}
.cb-acts button.ok{color:var(--vscode-terminal-ansiGreen);opacity:1;}
.cb-tabs{display:flex;gap:1px;margin-right:4px;}
.cb-tab{background:none;border:none;cursor:pointer;font-size:12px;opacity:.4;padding:0 2px;line-height:1;transition:opacity .15s;}
.cb-tab:hover,.cb-tab.active{opacity:1;}
.cb pre{margin:0;padding:10px 12px;overflow-x:auto;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);font-size:12px;line-height:1.5;tab-size:2;}
.hl-kw{color:#c586c0;}.hl-str{color:#ce9178;}.hl-cm{color:#6a9955;opacity:.85;}
.hl-nm{color:#b5cea8;}.hl-tp{color:#4ec9b0;}.hl-fn{color:#dcdcaa;}
.cursor{display:inline-block;width:2px;height:13px;background:var(--vscode-terminal-ansiGreen);animation:blink .7s step-end infinite;vertical-align:text-bottom;margin-left:1px;}
@keyframes blink{50%{opacity:0}}
.thinking{display:flex;align-items:center;gap:3px;opacity:.55;font-style:italic;font-size:12px;}
.thinking .d{animation:dp 1.4s infinite;display:inline-block;}
.thinking .d:nth-child(2){animation-delay:.2s;}
.thinking .d:nth-child(3){animation-delay:.4s;}
@keyframes dp{0%,80%,100%{opacity:.2}40%{opacity:1}}

/* ── Download bar ──────────────────────────────────────── */
#download-bar{display:none;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);}
#dl-text{font-size:11px;margin-bottom:4px;}
#dl-track{width:100%;height:4px;background:var(--vscode-input-background);border-radius:2px;overflow:hidden;}
#dl-fill{width:0%;height:100%;background:var(--vscode-button-background);transition:width 0.3s;}

/* ── Context bar ───────────────────────────────────────── */
#ctx{display:none;padding:4px 10px;font-size:11px;align-items:center;gap:6px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-panel-border);}
#ctx.on{display:flex;}
#ctx .info{flex:1;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#ctx .rm{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;opacity:.45;font-size:12px;}
#ctx .rm:hover{opacity:1;}

/* ── Input area ────────────────────────────────────────── */
#input-area{border-top:1px solid var(--vscode-panel-border);flex-shrink:0;}
#input-row{display:flex;padding:8px 10px;gap:6px;align-items:flex-end;}
#input-row textarea{
  flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border);border-radius:8px;
  padding:8px 12px;font-family:var(--vscode-font-family);font-size:13px;
  resize:none;min-height:38px;max-height:150px;line-height:1.4;transition:border-color .2s;
}
#input-row textarea:focus{outline:none;border-color:var(--vscode-focusBorder);}
.act-btn{width:34px;height:34px;border:none;border-radius:8px;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;transition:all .15s;}
#send-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}
#send-btn:hover{filter:brightness(1.15);}
#send-btn:disabled{opacity:.35;cursor:not-allowed;}
#stop-btn{background:var(--vscode-errorForeground);color:#fff;display:none;}
#stop-btn:hover{opacity:.8;}
#stats{display:flex;justify-content:space-between;align-items:center;padding:2px 12px 6px;font-size:10px;opacity:.45;}
.temp-ctrl{display:flex;align-items:center;gap:4px;cursor:default;}
.temp-ctrl input[type=range]{width:55px;height:3px;-webkit-appearance:none;appearance:none;background:var(--vscode-scrollbarSlider-background);border-radius:2px;outline:none;cursor:pointer;}
.temp-ctrl input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:var(--vscode-button-background);cursor:pointer;}
.codicon{font-size:inherit;vertical-align:middle;}
.msg-hdr .codicon{font-size:12px;}
.tb .codicon{font-size:14px;}
.act-btn .codicon{font-size:15px;}
.cb-acts .codicon{font-size:10px;}
.qa .codicon{font-size:13px;margin-right:2px;}
#welcome .logo .codicon{font-size:44px;}

/* ── Settings modal ────────────────────────────────────── */
#settings-overlay{
  display:none;position:absolute;inset:0;z-index:100;
  background:rgba(0,0,0,.6);backdrop-filter:blur(2px);
  align-items:center;justify-content:center;
}
#settings-overlay.open{display:flex;}
#settings-panel{
  background:var(--vscode-editorWidget-background);
  border:1px solid var(--vscode-panel-border);border-radius:10px;
  width:calc(100% - 32px);max-width:380px;max-height:85vh;overflow-y:auto;
  padding:0;box-shadow:0 8px 32px rgba(0,0,0,.4);animation:slideUp .2s ease;
  position:relative;
}
@keyframes slideUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
#settings-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:14px 16px 10px;border-bottom:1px solid var(--vscode-panel-border);
  position:sticky;top:0;background:var(--vscode-editorWidget-background);z-index:1;
}
#settings-header h3{font-size:14px;font-weight:700;}
#settings-close{background:none;border:none;cursor:pointer;color:var(--vscode-foreground);opacity:.6;font-size:16px;padding:2px;}
#settings-close:hover{opacity:1;}
#settings-body{padding:14px 16px;}
.settings-section{margin-bottom:18px;}
.settings-section-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.5;margin-bottom:8px;}
.settings-field{margin-bottom:12px;}
.settings-field label{display:block;font-size:12px;margin-bottom:4px;opacity:.8;}
.settings-field input,.settings-field select{
  width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border);border-radius:5px;
  padding:6px 10px;font-size:12px;font-family:var(--vscode-font-family);
}
.settings-field input:focus,.settings-field select:focus{outline:none;border-color:var(--vscode-focusBorder);}
.settings-field input[type=password]{letter-spacing:.1em;}
.settings-hint{font-size:10px;opacity:.45;margin-top:3px;}
#settings-footer{
  display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--vscode-panel-border);
  position:sticky;bottom:0;background:var(--vscode-editorWidget-background);
}
.settings-btn{flex:1;padding:7px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;}
#settings-save{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}
#settings-save:hover{filter:brightness(1.15);}
#settings-open-vsc{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
#settings-open-vsc:hover{filter:brightness(1.15);}

/* ── Support buttons ───────────────────────────────────── */
.support-btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;}
.support-btn{
  display:inline-flex;align-items:center;gap:5px;
  padding:6px 10px;border-radius:6px;font-size:11px;font-weight:700;
  text-decoration:none;flex:1;justify-content:center;cursor:pointer;
  border:none;transition:filter .15s,transform .1s;letter-spacing:.2px;
}
.support-btn:hover{filter:brightness(1.2);text-decoration:none;transform:translateY(-1px);}
.support-btn svg{flex-shrink:0;}
.support-btn-paypal{background:#003087;color:#fff;}
.support-btn-kofi{background:#FF5E5B;color:#fff;}
.support-btn-twitch{background:#9146FF;color:#fff;}
.support-tagline{font-size:10px;opacity:.5;margin-bottom:6px;line-height:1.4;}

/* ── Tool call blocks ──────────────────────────────────── */
.tool-block{
  margin:6px 0;border:1px solid var(--vscode-panel-border);
  border-radius:8px;overflow:hidden;font-size:11px;
  background:var(--vscode-editorWidget-background);
}
.tool-block-header{
  display:flex;align-items:center;gap:6px;padding:7px 10px;
  cursor:pointer;user-select:none;
  transition:background .15s;
}
.tool-block-header:hover{background:var(--vscode-list-hoverBackground);}
.tool-block-icon{font-size:13px;flex-shrink:0;}
.tool-block-name{font-weight:700;flex:1;font-family:var(--vscode-editor-font-family,monospace);}
.tool-block-status{font-size:11px;opacity:.7;flex-shrink:0;}
.tool-block-chevron{opacity:.5;font-size:11px;transition:transform .2s;flex-shrink:0;}
.tool-block.open .tool-block-chevron{transform:rotate(180deg);}
.tool-block-body{
  display:none;border-top:1px solid var(--vscode-panel-border);
  padding:8px 10px;
}
.tool-block.open .tool-block-body{display:block;}
.tool-block-section{margin-bottom:6px;}
.tool-block-section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;opacity:.45;margin-bottom:3px;}
.tool-block-pre{
  margin:0;padding:6px 8px;border-radius:4px;font-size:10px;
  background:var(--vscode-editor-background);
  overflow-x:auto;white-space:pre-wrap;word-break:break-all;
  max-height:120px;overflow-y:auto;
  font-family:var(--vscode-editor-font-family,monospace);
}
.tool-block-running .tool-block-header{border-left:3px solid var(--vscode-progressBar-background);}
.tool-block-done .tool-block-header{border-left:3px solid #3fb950;}
.tool-block-error .tool-block-header{border-left:3px solid var(--vscode-errorForeground);}

/* ── Export menu ───────────────────────────────────────── */
#export-menu{
  position:absolute;top:32px;right:8px;z-index:50;
  background:var(--vscode-editorWidget-background);
  border:1px solid var(--vscode-panel-border);border-radius:7px;
  box-shadow:0 4px 16px rgba(0,0,0,.3);overflow:hidden;
  display:none;min-width:180px;animation:fadeUp .15s ease;
}
#export-menu.open{display:block;}
.export-menu-item{
  display:flex;align-items:center;gap:8px;
  padding:8px 12px;font-size:12px;cursor:pointer;
  transition:background .1s;
}
.export-menu-item:hover{background:var(--vscode-list-hoverBackground);}
.export-menu-item i{opacity:.7;}

/* ── Rename input ──────────────────────────────────────── */
.conv-rename-input{
  width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-focusBorder);border-radius:4px;
  padding:2px 6px;font-size:12px;font-family:var(--vscode-font-family);
}
.conv-rename-input:focus{outline:none;}

/* ── HF Hub browser ────────────────────────────────────── */
#hf-overlay{
  display:none;position:absolute;inset:0;z-index:100;
  background:rgba(0,0,0,.6);backdrop-filter:blur(2px);
  align-items:flex-start;justify-content:center;padding-top:36px;
}
#hf-overlay.open{display:flex;}
#hf-panel{
  background:var(--vscode-editorWidget-background);
  border:1px solid var(--vscode-panel-border);border-radius:10px;
  width:calc(100% - 32px);max-width:400px;max-height:78vh;
  display:flex;flex-direction:column;
  box-shadow:0 8px 32px rgba(0,0,0,.4);animation:slideUp .2s ease;
}
#hf-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:12px 16px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;
}
#hf-header h3{font-size:13px;font-weight:700;}
#hf-close{background:none;border:none;cursor:pointer;color:var(--vscode-foreground);opacity:.6;font-size:16px;padding:2px;}
#hf-close:hover{opacity:1;}
#hf-search-row{padding:10px 14px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;display:flex;gap:6px;}
#hf-search-input{
  flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border);border-radius:5px;
  padding:6px 10px;font-size:12px;font-family:var(--vscode-font-family);
}
#hf-search-input:focus{outline:none;border-color:var(--vscode-focusBorder);}
#hf-search-btn{
  padding:6px 12px;background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);border:none;border-radius:5px;
  cursor:pointer;font-size:12px;white-space:nowrap;
}
#hf-search-btn:hover{filter:brightness(1.15);}
#hf-results{flex:1;overflow-y:auto;padding:6px;}
.hf-model-row{
  padding:8px 10px;border-radius:6px;margin-bottom:4px;
  display:flex;align-items:center;gap:8px;
  border:1px solid var(--vscode-panel-border);
  background:var(--vscode-sideBar-background);
}
.hf-model-row:hover{background:var(--vscode-list-hoverBackground);}
.hf-model-info{flex:1;min-width:0;}
.hf-model-name{font-size:12px;font-weight:600;font-family:var(--vscode-editor-font-family);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.hf-model-meta{font-size:10px;opacity:.5;margin-top:2px;}
.hf-dl-btn{
  padding:4px 10px;background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);border:none;border-radius:4px;
  cursor:pointer;font-size:11px;flex-shrink:0;white-space:nowrap;
}
.hf-dl-btn:hover{filter:brightness(1.15);}
.hf-dl-btn:disabled{opacity:.4;cursor:not-allowed;}
#hf-footer{
  padding:7px 14px;border-top:1px solid var(--vscode-panel-border);
  font-size:10px;opacity:.4;text-align:center;flex-shrink:0;line-height:1.4;
}
</style>
</head>
<body>

<!-- ── Toolbar ──────────────────────────────────────────── -->
<div id="toolbar">
  <button class="tb" id="sidebar-toggle" title="Conversaciones"><i class="codicon codicon-layout-sidebar-left"></i></button>
  <div id="status"><span class="dot" id="dot"></span><span id="st-text">…</span></div>
  <select id="provider-select" title="Proveedor">
    <option value="remote" data-i18n="provider_remote">LM Studio / Ollama</option>
    <option value="local" data-i18n="provider_local">Local</option>
    <option value="agent" data-i18n="provider_agent">Agent</option>
  </select>
  <select id="model-select" title="Modelo"><option value="">cargando…</option></select>
  <button class="tb" id="folder-btn" style="display:none" title="Carpeta de modelos" onclick="vscode.postMessage({type:'chooseModelsDir'})"><i class="codicon codicon-folder-opened"></i></button>
  <span id="tps-badge" style="display:none"></span>
  <span id="mcp-badges"></span>
  <div style="position:relative">
    <button class="tb" id="export-btn" title="Exportar"><i class="codicon codicon-export"></i></button>
    <div id="export-menu">
      <div class="export-menu-item" id="export-current"><i class="codicon codicon-file"></i> Esta conversación</div>
      <div class="export-menu-item" id="export-all"><i class="codicon codicon-files"></i> Todas las conversaciones</div>
    </div>
  </div>
  <button class="tb" id="hf-btn" title="Buscar modelos en HuggingFace"><i class="codicon codicon-cloud-download"></i></button>
  <button class="tb" id="clear-btn" title="Limpiar chat"><i class="codicon codicon-trash"></i></button>
  <button class="tb" id="settings-btn" title="Configuración"><i class="codicon codicon-settings-gear"></i></button>
</div>

<!-- ── MCP panel ────────────────────────────────────────── -->
<div id="mcp-panel"></div>

<!-- ── Download bar ───────────────────────────────────────── -->
<div id="download-bar">
  <div id="dl-text">Descargando modelo…</div>
  <div id="dl-track"><div id="dl-fill"></div></div>
</div>

<!-- ── Main layout ────────────────────────────────────────── -->
<div id="main">

  <!-- ── Sidebar ──────────────────────────────────────────── -->
  <div id="sidebar">
    <div id="sidebar-head">
      <span data-i18n="sidebar_title">Conversaciones</span>
      <button id="new-conv-btn" title="Nueva conversación" data-i18n="new_conv">+ Nueva</button>
    </div>
    <div id="conv-list"><div id="conv-empty" data-i18n="no_convs">Sin conversaciones</div></div>
  </div>

  <!-- ── Chat area ──────────────────────────────────────────── -->
  <div id="chat-area">

    <!-- ── Messages ──────────────────────────────────────────── -->
    <div id="messages">
      <div id="welcome">
        <div class="logo"><i class="codicon codicon-hubot"></i></div>
        <h2 data-i18n="welcome_title">ApliArte AI Chat</h2>
        <p class="sub" id="welcome-sub" data-i18n="welcome_sub">100% local · 0 coste · Tus datos, tu máquina</p>
        <div id="welcome-guide" style="display:none;margin:10px 0 14px;padding:10px 14px;border-radius:8px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border);text-align:left;font-size:12px;max-width:280px;"></div>
        <div id="welcome-dl-btn" style="display:none;margin-bottom:12px;">
          <button id="auto-dl-btn" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:8px;padding:9px 18px;cursor:pointer;font-size:13px;font-weight:600;" onclick="triggerAutoDownload()"><i class="codicon codicon-cloud-download"></i> <span data-i18n="dl_recommended">Descargar modelo recomendado (~350MB)</span></button>
          <p style="margin-top:6px;font-size:10px;opacity:.45;" data-i18n="dl_once">Solo la primera vez. Se guarda localmente.</p>
        </div>
        <div id="welcome-folder-btn" style="display:none;margin-bottom:12px;">
          <button onclick="vscode.postMessage({type:'chooseModelsDir'})" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:8px;padding:11px 22px;cursor:pointer;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;margin:0 auto;"><i class="codicon codicon-folder-opened"></i> <span data-i18n="welcome_choose_folder">Elegir carpeta de modelos</span></button>
          <p style="margin-top:8px;font-size:11px;opacity:.55;" data-i18n="welcome_folder_hint">Apuntá a donde tenés tus modelos descargados (disco externo, tarjeta SD, etc.)</p>
        </div>
        <div id="models-dir-badge" style="display:none;margin-bottom:10px;font-size:10px;opacity:.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;" title="Carpeta de modelos activa"></div>
        <div class="qa">
          <button onclick="reqCtx('file')"><i class="codicon codicon-file"></i> <span data-i18n="qa_file">Enviar archivo</span></button>
          <button onclick="reqCtx('selection')"><i class="codicon codicon-code"></i> <span data-i18n="qa_sel">Enviar selección</span></button>
        </div>
      </div>
    </div>

    <!-- ── Context bar ────────────────────────────────────────── -->
    <div id="ctx">
      <span><i class="codicon codicon-pin"></i></span><span class="info" id="ctx-info"></span>
      <button class="rm" id="ctx-rm" title="Quitar contexto">✕</button>
    </div>

    <!-- ── Slow model banner ──────────────────────────────────── -->
    <div id="slow-banner" style="display:none">
      <span id="slow-banner-text"></span>
      <button id="slow-banner-btn" onclick="applySlowBannerModel()"></button>
      <button class="slow-banner-close" onclick="dismissSlowBanner()">✕</button>
    </div>

    <!-- ── Input area ─────────────────────────────────────────── -->
    <div id="input-area">
      <div id="input-row">
        <button class="act-btn tb" id="attach-btn" title="Adjuntar archivo o selección"><i class="codicon codicon-pin"></i></button>
        <textarea id="input" rows="1" placeholder="Escribe tu mensaje…" data-i18n-placeholder="input_placeholder"></textarea>
        <button class="act-btn" id="send-btn" title="Enviar (Enter)"><i class="codicon codicon-play"></i></button>
        <button class="act-btn" id="stop-btn" title="Detener generación"><i class="codicon codicon-debug-stop"></i></button>
      </div>
      <div id="stats">
        <span id="wc">0 palabras</span>
        <div class="temp-ctrl">
          <span><i class="codicon codicon-dashboard"></i></span>
          <input type="range" id="temp" min="0" max="1.5" step="0.1" value="0.7">
          <span id="temp-val">0.7</span>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- ── HF Hub browser ──────────────────────────────────────── -->
<div id="hf-overlay">
  <div id="hf-panel">
    <div id="hf-header">
      <h3><i class="codicon codicon-cloud-download"></i> <span data-i18n="hf_title">Buscar modelos ONNX</span></h3>
      <button id="hf-close">✕</button>
    </div>
    <div id="hf-search-row">
      <input type="text" id="hf-search-input" data-i18n-placeholder="hf_search_ph" placeholder="Ej: Qwen, SmolLM, phi…">
      <button id="hf-search-btn"><i class="codicon codicon-search"></i> <span data-i18n="hf_search_btn">Buscar</span></button>
    </div>
    <div id="hf-results">
      <div id="hf-status" style="padding:20px;text-align:center;font-size:12px;opacity:.5;font-style:italic;">Buscá modelos compatibles para inferencia local</div>
    </div>
    <div id="hf-footer" data-i18n="hf_footer">Los modelos se descargan a tu carpeta de modelos configurada · Solo formato ONNX</div>
  </div>
</div>

<!-- ── Settings modal ─────────────────────────────────────── -->
<div id="settings-overlay">
  <div id="settings-panel">
    <div id="settings-header">
      <h3><i class="codicon codicon-settings-gear"></i> <span data-i18n="settings_title">Configuración</span></h3>
      <button id="settings-close">✕</button>
    </div>
    <div id="settings-body">
      <div class="settings-section">
        <div class="settings-section-title" data-i18n="s_behavior">Comportamiento</div>
        <div class="settings-field">
          <label data-i18n="s_preset">Preset del sistema</label>
          <select id="s-preset">
            <option value="minimal">Minimal — Conciso, ideal &le;8B</option>
            <option value="ecosystem-only">Medium — SDD + Ecosystem, 13B-30B</option>
            <option value="full-gentleman">Full Gentleman — Todo, modelos grandes</option>
          </select>
        </div>
        <div class="settings-field">
          <label data-i18n="s_lang">Idioma</label>
          <select id="s-language">
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">LM Studio / Ollama</div>
        <div class="settings-field">
          <label data-i18n="s_lmstudio">Endpoint LM Studio</label>
          <input type="text" id="s-lmstudio" placeholder="http://localhost:1234/v1">
        </div>
        <div class="settings-field">
          <label data-i18n="s_ollama">Endpoint Ollama</label>
          <input type="text" id="s-ollama" placeholder="http://localhost:11434">
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title" data-i18n="s_models_dir_title">📁 Carpeta de modelos</div>
        <p class="settings-hint" style="margin-bottom:8px;" data-i18n="s_models_dir_desc">Elegí dónde guardás tus modelos de IA. Puede ser un disco externo, una tarjeta SD o cualquier carpeta. Yo los busco ahí automáticamente.</p>
        <div id="models-dir-card">
          <div class="dir-path empty" id="models-dir-display" data-i18n="s_models_dir_none">Sin carpeta configurada (usa almacenamiento por defecto)</div>
          <input type="hidden" id="s-modelsdir">
          <button class="change-dir-btn" onclick="vscode.postMessage({type:'chooseModelsDir'})">
            <i class="codicon codicon-folder-opened"></i> <span data-i18n="s_choose_dir_big">Cambiar carpeta de modelos</span>
          </button>
          <div id="move-models-helper">
            <p data-i18n="s_move_models_info">¿Tenés modelos en otro lugar? Dale este prompt al Agente para que los mueva:</p>
            <div class="move-prompt-wrap">
              <textarea id="move-prompt-text" readonly></textarea>
              <button class="copy-prompt-btn" onclick="copyMovePrompt()" data-i18n="s_copy">Copiar</button>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title" data-i18n="s_agent_title">🤖 Agente Remoto</div>
        <div class="settings-field">
          <label data-i18n="s_agent_endpoint">URL del servidor</label>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="s-agent" data-i18n-placeholder="s_agent_ph" placeholder="https://mi-servidor.com" style="flex:1">
            <button class="info-btn" onclick="toggleAgentInfo()" title="¿Cómo creo mi propio servidor?">ℹ</button>
          </div>
          <div id="agent-info-box" class="info-box" style="display:none;">
            <p data-i18n="agent_info_1">Necesitás tu propio servidor para usar el modo Agente. Es el backend que habla con el LLM en la nube por vos.</p>
            <p data-i18n="agent_info_2">La forma más fácil es desplegarlo en Hostinger (VPS desde €4/mes):</p>
            <button class="host-btn" onclick="openUrl('https://www.hostinger.com/es?REFERRALCODE=APLIARTE')">
              🚀 <span data-i18n="agent_hostinger">Abrir Hostinger (descuento incluido)</span>
            </button>
            <p style="margin-top:8px;" data-i18n="agent_info_3">O seguí la guía del repositorio para instalar el backend en cualquier servidor.</p>
          </div>
        </div>
        <div class="settings-field">
          <label data-i18n="s_apikey">API Key</label>
          <input type="password" id="s-apikey" placeholder="sk-...">
          <div class="settings-hint" data-i18n="s_apikey_hint">Se guarda en configuración global de VS Code</div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title" data-i18n="s_mcp_local_title">🔌 Agregar herramienta MCP local</div>
        <p class="settings-hint" style="margin-bottom:8px;" data-i18n="s_mcp_local_desc">Conectá servidores MCP que corren en tu máquina — sin internet, 100% privado.</p>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="mcp-preset-btn" onclick="addMcpPreset('memory')">
            <span class="preset-icon">🧠</span>
            <div>
              <div data-i18n="mcp_memory_label">Memoria local</div>
              <div class="mcp-preset-desc" data-i18n="mcp_memory_desc">Guarda contexto entre conversaciones, sin internet</div>
            </div>
          </button>
          <button class="mcp-preset-btn" onclick="addMcpPreset('filesystem')">
            <span class="preset-icon">📁</span>
            <div>
              <div data-i18n="mcp_fs_label">Acceso al sistema de archivos</div>
              <div class="mcp-preset-desc" data-i18n="mcp_fs_desc">El agente puede leer y escribir en una carpeta de tu máquina</div>
            </div>
          </button>
        </div>
        <div class="settings-hint" style="margin-top:6px;" data-i18n="s_mcp_local_hint">Requiere Node.js. Se agrega a apliarteAi.mcpServers automáticamente.</div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title" data-i18n="s_support_title">❤️ Apoyar el proyecto</div>
        <p class="support-tagline" data-i18n="s_support_sub">ApliArte AI es gratuito. Si te ahorra tiempo, un café ayuda a seguir desarrollándolo.</p>
        <div class="support-btns">
          <button class="support-btn support-btn-paypal" onclick="openUrl('https://paypal.me/erbolamm')">
            <svg width="13" height="15" viewBox="0 0 24 28" fill="currentColor"><path d="M19.5 3.5C18.2 2.2 16.3 1.5 14 1.5H6.5c-.8 0-1.5.6-1.6 1.4L2 21.4c-.1.6.4 1.1 1 1.1h4.5l1.1-7.1v.4c.1-.8.8-1.4 1.6-1.4h3.3c6.6 0 11.7-2.7 13.2-10.4.1-.3.1-.6.1-.9-.4-2.3-1.5-4-2.8-5.1.2.1.3.2.5.3z"/></svg>
            PayPal
          </button>
          <button class="support-btn support-btn-kofi" onclick="openUrl('https://ko-fi.com/C0C11TWR1K')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M23.881 8.948c-.773-4.085-4.859-4.593-4.859-4.593H.723c-.604 0-.679.798-.679.798s-.082 7.324-.022 11.822c.164 2.424 2.586 2.672 2.586 2.672s8.267-.023 11.966-.049c2.438-.426 2.683-2.566 2.658-3.734 4.352.24 7.422-2.831 6.649-6.916zm-11.062 3.511c-1.246 1.453-4.011 3.976-4.011 3.976s-.121.119-.31.023c-.076-.057-.108-.09-.108-.09-.443-.441-3.368-3.049-4.034-3.954-.709-.965-1.041-2.7-.091-3.71.951-1.01 3.005-1.086 4.363.407 0 0 1.565-1.782 3.468-.963 1.904.82 1.832 2.739.723 4.311zm6.173.478c-.928.116-1.682-.058-1.682-.058V7.284h1.77s1.971.551 1.971 2.638c0 1.913-.985 2.667-2.059 3.015z"/></svg>
            Ko-fi
          </button>
          <button class="support-btn support-btn-twitch" onclick="openUrl('https://streamelements.com/apliarte/tip')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>
            Twitch Tip
          </button>
        </div>
      </div>
    </div>
    <div id="settings-footer">
      <button class="settings-btn" id="settings-open-vsc"><i class="codicon codicon-gear"></i> <span data-i18n="s_open_vsc">Abrir VS Code Settings</span></button>
      <button class="settings-btn" id="settings-save"><i class="codicon codicon-save"></i> <span data-i18n="s_save">Guardar</span></button>
    </div>
  </div>
</div>

<script>
/* ================================================================
   ApliArte AI Chat — Webview JS v0.6.0
   ================================================================ */
var vscode = acquireVsCodeApi();
var msgs    = document.getElementById('messages');
var input   = document.getElementById('input');
var sendB   = document.getElementById('send-btn');
var stopB   = document.getElementById('stop-btn');
var clearB  = document.getElementById('clear-btn');
var expB    = document.getElementById('export-btn');
var expMenu = document.getElementById('export-menu');
var attB    = document.getElementById('attach-btn');
var dot     = document.getElementById('dot');
var stTxt   = document.getElementById('st-text');
var mSel    = document.getElementById('model-select');
var pSel    = document.getElementById('provider-select');
var dlBar   = document.getElementById('download-bar');
var dlText  = document.getElementById('dl-text');
var dlFill  = document.getElementById('dl-fill');
var ctxBar  = document.getElementById('ctx');
var ctxI    = document.getElementById('ctx-info');
var ctxRm   = document.getElementById('ctx-rm');
var wcEl    = document.getElementById('wc');
var tempIn  = document.getElementById('temp');
var tempV   = document.getElementById('temp-val');
var welc    = document.getElementById('welcome');
var sidebar = document.getElementById('sidebar');
var convList= document.getElementById('conv-list');
var sidebarToggle = document.getElementById('sidebar-toggle');
var settingsOverlay = document.getElementById('settings-overlay');
var settingsBtn     = document.getElementById('settings-btn');
var settingsClose   = document.getElementById('settings-close');
var settingsSave    = document.getElementById('settings-save');
var settingsOpenVsc = document.getElementById('settings-open-vsc');
var hfOverlay     = document.getElementById('hf-overlay');
var hfClose       = document.getElementById('hf-close');
var hfSearchInput = document.getElementById('hf-search-input');
var hfSearchBtn   = document.getElementById('hf-search-btn');
var hfResultsEl   = document.getElementById('hf-results');
var mcpBadgesEl     = document.getElementById('mcp-badges');
var mcpPanelEl      = document.getElementById('mcp-panel');
var mcpServers      = [];
var mcpPanelOpen    = false;
var newConvBtn      = document.getElementById('new-conv-btn');

var streaming   = false;
var curEl       = null;
var rawText     = '';
var codeBlocks      = [];
var currentProvider = 'remote';
var activeConvId    = null;
var sidebarOpen  = true;
var currentProject = undefined;

/* ── Sidebar toggle ────────────────────────────────────────── */
sidebarToggle.addEventListener('click', function() {
  sidebarOpen = !sidebarOpen;
  sidebar.classList.toggle('collapsed', !sidebarOpen);
  sidebarToggle.classList.toggle('active', sidebarOpen);
});

/* ── New conversation ──────────────────────────────────────── */
newConvBtn.addEventListener('click', function() {
  vscode.postMessage({ type: 'newConversation' });
});

/* ── Render conversation list ──────────────────────────────── */
function renderConversations(conversations, activeId) {
  activeConvId = activeId;
  convList.innerHTML = '';
  if (!conversations || conversations.length === 0) {
    var t = I18N[currentLang] || I18N['es'];
    convList.innerHTML = '<div id="conv-empty">' + esc(t['no_convs'] || 'Sin conversaciones') + '</div>';
    return;
  }
  conversations.forEach(function(conv) {
    var div = document.createElement('div');
    div.className = 'conv-item' + (conv.id === activeId ? ' active' : '');
    div.dataset.id = conv.id;

    var date = new Date(conv.updatedAt);
    var dateStr = date.toLocaleDateString('es-ES', { month:'short', day:'numeric' });
    var timeStr = date.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' });

    div.innerHTML =
      '<div class="conv-title">' + esc(conv.title) + '</div>' +
      '<div class="conv-meta">' + dateStr + ' ' + timeStr + ' · ' + conv.messageCount + ' msgs</div>' +
      (conv.preview ? '<div class="conv-preview">' + esc(conv.preview) + '</div>' : '') +
      '<div class="conv-actions">' +
        '<button class="conv-act-btn" data-action="rename" title="Renombrar"><i class="codicon codicon-edit"></i></button>' +
        '<button class="conv-act-btn" data-action="export" title="Exportar"><i class="codicon codicon-export"></i></button>' +
        '<button class="conv-act-btn danger" data-action="delete" title="Eliminar"><i class="codicon codicon-trash"></i></button>' +
      '</div>';

    div.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-action]');
      if (btn) {
        e.stopPropagation();
        var action = btn.dataset.action;
        if (action === 'rename') startRename(conv.id, conv.title, div);
        if (action === 'export') vscode.postMessage({ type: 'exportConversation', id: conv.id });
        if (action === 'delete') {
          var trashBtn = btn;
          if (trashBtn.dataset.confirming) {
            vscode.postMessage({ type: 'deleteConversation', id: conv.id });
          } else {
            trashBtn.dataset.confirming = '1';
            trashBtn.innerHTML = '<i class="codicon codicon-warning"></i>';
            trashBtn.style.color = 'var(--vscode-errorForeground)';
            trashBtn.title = 'Clic de nuevo para confirmar';
            setTimeout(function() {
              delete trashBtn.dataset.confirming;
              trashBtn.innerHTML = '<i class="codicon codicon-trash"></i>';
              trashBtn.style.color = '';
              trashBtn.title = 'Eliminar';
            }, 2500);
          }
        }
        return;
      }
      if (conv.id !== activeConvId) {
        vscode.postMessage({ type: 'loadConversation', id: conv.id });
      }
    });

    convList.appendChild(div);
  });
}

function startRename(id, currentTitle, itemEl) {
  var titleEl = itemEl.querySelector('.conv-title');
  var inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'conv-rename-input';
  inp.value = currentTitle;
  titleEl.replaceWith(inp);
  inp.focus();
  inp.select();

  function commit() {
    var newTitle = inp.value.trim() || currentTitle;
    vscode.postMessage({ type: 'renameConversation', id: id, title: newTitle });
  }
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { inp.value = currentTitle; inp.blur(); }
  });
}

/* ── Settings ──────────────────────────────────────────────── */
settingsBtn.addEventListener('click', function() {
  settingsOverlay.classList.add('open');
  vscode.postMessage({ type: 'getSettings' });
});
settingsClose.addEventListener('click', function() { settingsOverlay.classList.remove('open'); });
settingsOverlay.addEventListener('click', function(e) {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('open');
});
document.getElementById('s-language').addEventListener('change', function() {
  applyLang(this.value);
});

settingsSave.addEventListener('click', function() {
  vscode.postMessage({
    type: 'saveSettings',
    settings: {
      preset:           document.getElementById('s-preset').value,
      language:         document.getElementById('s-language').value,
      lmstudioEndpoint: document.getElementById('s-lmstudio').value.trim(),
      ollamaEndpoint:   document.getElementById('s-ollama').value.trim(),
      agentEndpoint:    document.getElementById('s-agent').value.trim(),
      agentApiKey:      document.getElementById('s-apikey').value.trim(),
      modelsDir:        document.getElementById('s-modelsdir').value.trim(),
    }
  });
  settingsOverlay.classList.remove('open');
});
settingsOpenVsc.addEventListener('click', function() {
  vscode.postMessage({ type: 'openVscodeSettings' });
});

function openUrl(url) {
  vscode.postMessage({ type: 'openUrl', url: url });
}

/* ── i18n ──────────────────────────────────────────────────── */
var currentLang = 'es';
var I18N = {
  es: {
    provider_remote: 'LM Studio / Ollama',
    provider_local: 'Local',
    provider_agent: 'Agent',
    sidebar_title: 'Conversaciones',
    new_conv: '+ Nueva',
    no_convs: 'Sin conversaciones',
    welcome_title: 'ApliArte AI Chat',
    welcome_sub: '100% local · 0 coste · Tus datos, tu máquina',
    welcome_choose_folder: 'Elegir carpeta de modelos',
    welcome_folder_hint: 'Apuntá a donde tenés tus modelos descargados (disco externo, tarjeta SD, etc.)',
    dl_recommended: 'Descargar modelo recomendado (~350MB)',
    dl_once: 'Solo la primera vez. Se guarda localmente.',
    qa_file: 'Enviar archivo',
    qa_sel: 'Enviar selección',
    input_placeholder: 'Escribe tu mensaje…',
    settings_title: 'Configuración',
    s_behavior: 'Comportamiento',
    s_preset: 'Preset del sistema',
    s_lang: 'Idioma',
    s_lmstudio: 'Endpoint LM Studio',
    s_ollama: 'Endpoint Ollama',
    s_models_dir_title: '📁 Carpeta de modelos',
    s_models_dir_desc: 'Elegí dónde guardás tus modelos de IA. Puede ser un disco externo, una tarjeta SD o cualquier carpeta. Yo los busco ahí automáticamente.',
    s_models_dir_none: 'Sin carpeta configurada (usa almacenamiento por defecto)',
    s_choose_dir_big: 'Cambiar carpeta de modelos',
    s_move_models_info: '¿Tenés modelos en otro lugar? Dale este prompt al Agente para que los mueva:',
    s_copy: 'Copiar',
    s_agent_title: '🤖 Agente Remoto',
    s_agent_endpoint: 'URL del servidor',
    s_agent_ph: 'https://mi-servidor.com',
    agent_info_1: 'Necesitás tu propio servidor para usar el modo Agente. Es el backend que habla con el LLM en la nube por vos.',
    agent_info_2: 'La forma más fácil es desplegarlo en Hostinger (VPS desde €4/mes):',
    agent_hostinger: 'Abrir Hostinger (descuento incluido)',
    agent_info_3: 'O seguí la guía del repositorio para instalar el backend en cualquier servidor.',
    s_apikey: 'API Key',
    s_apikey_hint: 'Se guarda en configuración global de VS Code',
    s_mcp_local_title: '🔌 Agregar herramienta MCP local',
    s_mcp_local_desc: 'Conectá servidores MCP que corren en tu máquina — sin internet, 100% privado.',
    mcp_memory_label: 'Memoria local',
    mcp_memory_desc: 'Guarda contexto entre conversaciones, sin internet',
    mcp_fs_label: 'Acceso al sistema de archivos',
    mcp_fs_desc: 'El agente puede leer y escribir en una carpeta de tu máquina',
    s_mcp_local_hint: 'Requiere Node.js. Se agrega a apliarteAi.mcpServers automáticamente.',
    s_support_title: '❤️ Apoyar el proyecto',
    s_support_sub: 'ApliArte AI es gratuito. Si te ahorra tiempo, un café ayuda a seguir desarrollándolo.',
    s_open_vsc: 'Abrir VS Code Settings',
    s_save: 'Guardar',
    hf_title: 'Buscar modelos ONNX',
    hf_search_ph: 'Ej: Qwen, SmolLM, phi…',
    hf_search_btn: 'Buscar',
    hf_footer: 'Los modelos se descargan a tu carpeta de modelos configurada · Solo formato ONNX',
  },
  en: {
    provider_remote: 'LM Studio / Ollama',
    provider_local: 'Local',
    provider_agent: 'Agent',
    sidebar_title: 'Conversations',
    new_conv: '+ New',
    no_convs: 'No conversations',
    welcome_title: 'ApliArte AI Chat',
    welcome_sub: '100% local · zero cost · your data, your machine',
    welcome_choose_folder: 'Choose models folder',
    welcome_folder_hint: 'Point to where your downloaded models are (external drive, SD card, etc.)',
    dl_recommended: 'Download recommended model (~350MB)',
    dl_once: 'Only the first time. Saved locally.',
    qa_file: 'Send file',
    qa_sel: 'Send selection',
    input_placeholder: 'Write your message…',
    settings_title: 'Settings',
    s_behavior: 'Behavior',
    s_preset: 'System preset',
    s_lang: 'Language',
    s_lmstudio: 'LM Studio endpoint',
    s_ollama: 'Ollama endpoint',
    s_models_dir_title: '📁 Models folder',
    s_models_dir_desc: 'Choose where to store your AI models. External drive, SD card, or any folder. I\'ll find them there automatically.',
    s_models_dir_none: 'No folder configured (uses default storage)',
    s_choose_dir_big: 'Change models folder',
    s_move_models_info: 'Have models elsewhere? Give this prompt to the Agent to move them:',
    s_copy: 'Copy',
    s_agent_title: '🤖 Remote Agent',
    s_agent_endpoint: 'Server URL',
    s_agent_ph: 'https://my-server.com',
    agent_info_1: 'You need your own server to use Agent mode. It\'s the backend that talks to the cloud LLM for you.',
    agent_info_2: 'Easiest way: deploy on Hostinger (VPS from €4/mo):',
    agent_hostinger: 'Open Hostinger (discount included)',
    agent_info_3: 'Or follow the repo guide to install the backend on any server.',
    s_apikey: 'API Key',
    s_apikey_hint: 'Saved in VS Code global settings',
    s_mcp_local_title: '🔌 Add local MCP tool',
    s_mcp_local_desc: 'Connect MCP servers running on your machine — no internet, 100% private.',
    mcp_memory_label: 'Local memory',
    mcp_memory_desc: 'Saves context between conversations, no internet',
    mcp_fs_label: 'Filesystem access',
    mcp_fs_desc: 'The agent can read and write to a folder on your machine',
    s_mcp_local_hint: 'Requires Node.js. Added to apliarteAi.mcpServers automatically.',
    s_support_title: '❤️ Support the project',
    s_support_sub: 'ApliArte AI is free. If it saves you time, a coffee helps keep it going.',
    s_open_vsc: 'Open VS Code Settings',
    s_save: 'Save',
    hf_title: 'Browse ONNX models',
    hf_search_ph: 'E.g. Qwen, SmolLM, phi…',
    hf_search_btn: 'Search',
    hf_footer: 'Models are downloaded to your configured models folder · ONNX format only',
  },
};

function applyLang(lang) {
  currentLang = lang || 'es';
  var t = I18N[currentLang] || I18N['es'];
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    var key = el.getAttribute('data-i18n');
    if (t[key] != null) el.textContent = t[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-placeholder');
    if (t[key] != null) el.placeholder = t[key];
  });
  // Update GUIDE_TEXTS language-sensitive strings
  if (lang === 'en') {
    GUIDE_TEXTS['local-needs-folder'].sub = 'Local mode — first set your models folder';
    GUIDE_TEXTS['local-needs-folder'].guide = '📁 <strong>Where are your models?</strong><br>Choose the folder where your downloaded models are (external drive, SD card, or any local folder). The extension will find them automatically.';
    GUIDE_TEXTS['local-needs-download'].sub = 'Local mode — inference on your machine, no internet';
    GUIDE_TEXTS['local-needs-download'].guide = '⬇️ <strong>First step:</strong> download the Qwen 2.5 model (0.5B, ~350MB).<br>Only once — loads in seconds after that.';
    GUIDE_TEXTS['local-ready'].sub = 'Local model ready — write your first message';
    GUIDE_TEXTS['local-ready'].guide = '✅ <strong>All set.</strong> Model loaded in memory. Write your question below.';
    GUIDE_TEXTS['remote-offline'].sub = 'LM Studio / Ollama — not detected';
    GUIDE_TEXTS['remote-offline'].guide = '⚠️ <strong>No model detected.</strong><br>Options:<br>• Open <strong>LM Studio</strong> or <strong>Ollama</strong> and load a model<br>• Or switch provider to <strong>Local</strong> for inference with no installs';
    GUIDE_TEXTS['remote-ready'].sub = 'Connected — write your first message';
    GUIDE_TEXTS['agent'].sub = 'Cloud Agent — check connection in Settings';
    GUIDE_TEXTS['agent'].guide = '☁️ <strong>Agent mode.</strong> Set the endpoint and API key in <i class="codicon codicon-settings-gear"></i> Settings.';
  } else {
    GUIDE_TEXTS['local-needs-folder'].sub = 'Modo local — primero configurá tu carpeta de modelos';
    GUIDE_TEXTS['local-needs-folder'].guide = '📁 <strong>¿Dónde guardás tus modelos?</strong><br>Elegí la carpeta donde están tus modelos descargados (disco externo, tarjeta SD, o cualquier carpeta local). La extensión los buscará ahí automáticamente.';
    GUIDE_TEXTS['local-needs-download'].sub = 'Modo local — inferencia en tu máquina, sin internet';
    GUIDE_TEXTS['local-needs-download'].guide = '⬇️ <strong>Primer paso:</strong> descargá el modelo Qwen 2.5 (0.5B, ~350MB).<br>Solo la primera vez — después carga en segundos.';
    GUIDE_TEXTS['local-ready'].sub = 'Modelo local listo — podés escribir tu primer mensaje';
    GUIDE_TEXTS['local-ready'].guide = '✅ <strong>Todo listo.</strong> El modelo está cargado en memoria. Escribí tu pregunta abajo.';
    GUIDE_TEXTS['remote-offline'].sub = 'LM Studio / Ollama — no detectado';
    GUIDE_TEXTS['remote-offline'].guide = '⚠️ <strong>No hay modelo detectado.</strong><br>Opciones:<br>• Abrí <strong>LM Studio</strong> o <strong>Ollama</strong> y cargá un modelo<br>• O cambiá el proveedor a <strong>Local</strong> para inferencia sin instalar nada';
    GUIDE_TEXTS['remote-ready'].sub = 'Conectado — podés escribir tu primer mensaje';
    GUIDE_TEXTS['agent'].sub = 'Agent Cloud — verificá la conexión en Configuración';
    GUIDE_TEXTS['agent'].guide = '☁️ <strong>Modo Agente.</strong> Configurá el endpoint y la API key en <i class="codicon codicon-settings-gear"></i> Configuración.';
  }
}

/* ── Info box (inline toggle) ──────────────────────────────── */
.info-box{
  margin-top:8px;padding:10px 12px;border-radius:6px;font-size:11px;
  background:var(--vscode-textBlockQuote-background,rgba(128,128,128,.08));
  border:1px solid var(--vscode-panel-border);line-height:1.6;
}
.info-box p{margin-bottom:6px;}
.info-box p:last-child{margin-bottom:0;}
.info-btn{
  background:none;border:none;cursor:pointer;color:var(--vscode-descriptionForeground);
  font-size:13px;padding:0 4px;opacity:.7;
}
.info-btn:hover{opacity:1;}
.host-btn{
  display:inline-flex;align-items:center;gap:5px;
  padding:5px 10px;background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);border:none;border-radius:5px;
  cursor:pointer;font-size:11px;font-weight:600;margin-top:4px;
}
.host-btn:hover{filter:brightness(1.15);}

/* ── MCP preset buttons ────────────────────────────────────── */
.mcp-preset-btn{
  display:flex;align-items:center;gap:8px;width:100%;
  padding:8px 12px;background:var(--vscode-button-secondaryBackground);
  color:var(--vscode-button-secondaryForeground);border:none;border-radius:6px;
  cursor:pointer;font-size:12px;text-align:left;transition:filter .15s;
}
.mcp-preset-btn:hover{filter:brightness(1.15);}
.mcp-preset-btn .preset-icon{font-size:16px;flex-shrink:0;}
.mcp-preset-desc{font-size:10px;opacity:.6;margin-top:1px;}

/* ── Models dir card ───────────────────────────────────────── */
#models-dir-card{
  padding:12px;border-radius:8px;margin-top:4px;
  border:2px dashed var(--vscode-panel-border);
  background:var(--vscode-sideBar-background);
  transition:border-color .2s;
}
#models-dir-card:hover{border-color:var(--vscode-focusBorder);}
#models-dir-card .dir-path{
  font-family:var(--vscode-editor-font-family);font-size:11px;
  opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  margin:4px 0 8px;
}
#models-dir-card .dir-path.empty{font-style:italic;opacity:.4;}
.change-dir-btn{
  display:flex;align-items:center;justify-content:center;gap:6px;width:100%;
  padding:8px;background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);border:none;border-radius:6px;
  cursor:pointer;font-size:12px;font-weight:600;transition:filter .15s;
}
.change-dir-btn:hover{filter:brightness(1.15);}
#move-models-helper{display:none;margin-top:10px;}
#move-models-helper p{font-size:11px;margin-bottom:5px;opacity:.7;}
.move-prompt-wrap{position:relative;}
#move-prompt-text{
  width:100%;font-size:10px;font-family:var(--vscode-editor-font-family);
  background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);
  border:1px solid var(--vscode-panel-border);border-radius:4px;
  padding:6px 36px 6px 8px;resize:none;height:60px;line-height:1.4;
}
.copy-prompt-btn{
  position:absolute;top:5px;right:5px;
  background:var(--vscode-button-secondaryBackground);
  color:var(--vscode-button-secondaryForeground);
  border:none;border-radius:3px;cursor:pointer;font-size:10px;padding:2px 5px;
}
.copy-prompt-btn:hover{filter:brightness(1.2);}

/* ── Agent info toggle ─────────────────────────────────────── */
function toggleAgentInfo() {
  var box = document.getElementById('agent-info-box');
  if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

/* ── Models dir helpers ────────────────────────────────────── */
function updateModelsDirCard(dir) {
  var display = document.getElementById('models-dir-display');
  var hidden  = document.getElementById('s-modelsdir');
  var helper  = document.getElementById('move-models-helper');
  var prompt  = document.getElementById('move-prompt-text');
  if (hidden) hidden.value = dir || '';
  if (display) {
    if (dir) {
      display.textContent = '📁 ' + dir;
      display.classList.remove('empty');
    } else {
      var t = I18N[currentLang] || I18N['es'];
      display.textContent = t['s_models_dir_none'] || 'Sin carpeta configurada';
      display.classList.add('empty');
    }
  }
  if (helper && prompt) {
    if (dir) {
      helper.style.display = 'block';
      prompt.value = 'Mueve todos mis modelos de IA a la carpeta: ' + dir + '\\n' +
        'Buscá modelos en las subcarpetas actuales (formatos: .onnx, .safetensors, .gguf, carpetas con config.json) y copialos o movelos ahí. Si ya están en esa carpeta, no hagas nada.';
    } else {
      helper.style.display = 'none';
    }
  }
}

function copyMovePrompt() {
  var txt = document.getElementById('move-prompt-text');
  if (!txt) return;
  navigator.clipboard.writeText(txt.value).then(function() {
    var btn = document.querySelector('.copy-prompt-btn');
    if (btn) { btn.textContent = '✓'; setTimeout(function() { btn.textContent = (I18N[currentLang] || I18N['es'])['s_copy'] || 'Copiar'; }, 1500); }
  });
}

/* ── MCP quick setup ───────────────────────────────────────── */
function addMcpPreset(type) {
  if (type === 'memory') {
    vscode.postMessage({ type: 'addMcpServer', name: 'memory', config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory']
    }});
  } else if (type === 'filesystem') {
    vscode.postMessage({ type: 'chooseMcpFolder' });
  }
}

/* ── HF Hub browser ────────────────────────────────────────── */
document.getElementById('hf-btn').addEventListener('click', function() { openHfBrowser(); });
hfClose.addEventListener('click', function() { hfOverlay.classList.remove('open'); });
hfOverlay.addEventListener('click', function(e) {
  if (e.target === hfOverlay) hfOverlay.classList.remove('open');
});
hfSearchBtn.addEventListener('click', function() { searchHf(); });
hfSearchInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') searchHf();
});

// ── Folder button visibility ─────────────────────────────────
var folderBtn = document.getElementById('folder-btn');
function updateFolderBtnVisibility(provider) {
  if (folderBtn) folderBtn.style.display = provider === 'local' ? 'flex' : 'none';
}

// ── Inference stats / slow-model banner ─────────────────────
var _tpsBadge       = document.getElementById('tps-badge');
var _slowBanner     = document.getElementById('slow-banner');
var _slowBannerText = document.getElementById('slow-banner-text');
var _slowBannerBtn  = document.getElementById('slow-banner-btn');
var _tpsBadgeTimer;
var _pendingSlowModel = null;
var _slowDismissedUntil = parseInt(localStorage.getItem('slowDismiss') || '0', 10);

function showInferenceStats(tps, suggestedModel) {
  if (!_tpsBadge) return;
  _tpsBadge.textContent = tps.toFixed(1) + ' t/s';
  _tpsBadge.className = tps >= 8 ? 'tps-ok' : tps >= 4 ? 'tps-warn' : 'tps-slow';
  _tpsBadge.style.display = 'inline';
  clearTimeout(_tpsBadgeTimer);
  _tpsBadgeTimer = setTimeout(function() { _tpsBadge.style.display = 'none'; }, 10000);

  if (tps < 8 && suggestedModel && Date.now() > _slowDismissedUntil) {
    _pendingSlowModel = suggestedModel;
    var shortName = suggestedModel.split('/').pop();
    _slowBannerText.textContent = '⚡ ' + tps.toFixed(1) + ' t/s — generación lenta. ¿Cambiar a ' + shortName + '?';
    _slowBannerBtn.textContent = 'Cambiar';
    _slowBanner.style.display = 'flex';
  }
}

function applySlowBannerModel() {
  if (!_pendingSlowModel) return;
  mSel.value = _pendingSlowModel;
  mSel.dispatchEvent(new Event('change'));
  dismissSlowBanner();
}

function dismissSlowBanner() {
  _slowBanner.style.display = 'none';
  _pendingSlowModel = null;
  _slowDismissedUntil = Date.now() + 10 * 60 * 1000;
  localStorage.setItem('slowDismiss', String(_slowDismissedUntil));
}

function openHfBrowser() {
  hfOverlay.classList.add('open');
  hfSearchInput.focus();
  // Auto-load popular models on first open
  if (hfResultsEl.children.length <= 1) {
    searchHf();
  }
}

function searchHf() {
  var query = hfSearchInput.value.trim();
  hfResultsEl.innerHTML = '<div style="padding:20px;text-align:center;font-size:12px;opacity:.5;"><i class="codicon codicon-loading codicon-modifier-spin"></i> Buscando…</div>';
  vscode.postMessage({ type: 'searchHfHub', query: query });
}

function renderHfResults(models, error) {
  hfResultsEl.innerHTML = '';
  if (error) {
    hfResultsEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--vscode-errorForeground);font-size:12px;"><i class="codicon codicon-warning"></i> ' + esc(error) + '</div>';
    return;
  }
  if (!models || models.length === 0) {
    hfResultsEl.innerHTML = '<div style="padding:16px;text-align:center;font-size:12px;opacity:.5;font-style:italic;">Sin resultados. Probá con otro término.</div>';
    return;
  }
  models.forEach(function(m) {
    var row = document.createElement('div');
    row.className = 'hf-model-row';
    var dlCount = m.downloads;
    var dlStr = dlCount != null ? (dlCount > 1000 ? Math.round(dlCount / 1000) + 'K' : dlCount) + ' descargas' : '';
    var tag = m.pipeline_tag || '';
    var meta = [dlStr, tag].filter(Boolean).join(' · ');
    var safeId = m.modelId.replace(/'/g, '');
    row.innerHTML =
      '<div class="hf-model-info">' +
        '<div class="hf-model-name" title="' + esc(m.modelId) + '">' + esc(m.modelId) + '</div>' +
        (meta ? '<div class="hf-model-meta">' + esc(meta) + '</div>' : '') +
      '</div>' +
      '<button class="hf-dl-btn" onclick="downloadHfModel(\'' + safeId + '\',this)">⬇ Descargar</button>';
    hfResultsEl.appendChild(row);
  });
}

function downloadHfModel(modelId, btn) {
  btn.disabled = true;
  btn.innerHTML = '<i class="codicon codicon-loading codicon-modifier-spin"></i>';
  hfOverlay.classList.remove('open');
  vscode.postMessage({ type: 'downloadModel', model: modelId });
}

function renderToolBlock(d) {
  if (!curEl) return;
  var body = curEl.querySelector('.msg-body');
  var blockId = 'tc-' + d.id.replace(/[^a-zA-Z0-9]/g, '_');

  if (d.status === 'running') {
    // Flush pending markdown text first
    if (rawText) {
      var mdDiv = document.createElement('div');
      mdDiv.innerHTML = renderMD(rawText);
      body.appendChild(mdDiv);
      rawText = '';
      body.querySelector('.cursor')?.remove();
    }
    var block = document.createElement('div');
    block.id = blockId;
    block.className = 'tool-block tool-block-running';
    block.innerHTML =
      '<div class="tool-block-header" onclick="toggleToolBlock(this.parentElement)">' +
        '<i class="codicon codicon-tools tool-block-icon"></i>' +
        '<span class="tool-block-name">' + esc(d.name) + '</span>' +
        '<span class="tool-block-status"><i class="codicon codicon-loading codicon-modifier-spin"></i> ejecutando…</span>' +
        '<i class="codicon codicon-chevron-down tool-block-chevron"></i>' +
      '</div>' +
      '<div class="tool-block-body">' +
        '<div class="tool-block-section">' +
          '<div class="tool-block-section-label">Argumentos</div>' +
          '<pre class="tool-block-pre">' + esc(JSON.stringify(d.args, null, 2)) + '</pre>' +
        '</div>' +
      '</div>';
    body.appendChild(block);
    msgs.scrollTop = msgs.scrollHeight;
  } else if (d.status === 'done') {
    var existing = document.getElementById(blockId);
    if (existing) {
      existing.className = 'tool-block tool-block-done';
      var statusEl = existing.querySelector('.tool-block-status');
      if (statusEl) statusEl.innerHTML = '✓ listo';
      var bodyEl = existing.querySelector('.tool-block-body');
      if (bodyEl) {
        var resultSection = document.createElement('div');
        resultSection.className = 'tool-block-section';
        var preview = (d.result || '').slice(0, 300);
        var truncated = (d.result || '').length > 300;
        resultSection.innerHTML =
          '<div class="tool-block-section-label">Resultado</div>' +
          '<pre class="tool-block-pre">' + esc(preview) + (truncated ? '\n…' : '') + '</pre>';
        bodyEl.appendChild(resultSection);
      }
    }
    msgs.scrollTop = msgs.scrollHeight;
  }
}

function toggleToolBlock(el) {
  el.classList.toggle('open');
}

function attachMcpResource(server, uri, name) {
  vscode.postMessage({ type: 'attachMcpResource', server: server, uri: uri, name: name });
  toggleMcpPanel();
}

function invokeMcpPrompt(server, promptName) {
  vscode.postMessage({ type: 'invokeMcpPrompt', server: server, promptName: promptName });
  toggleMcpPanel();
}

function renderMcpBadges(servers) {
  mcpServers = servers || [];
  if (!mcpBadgesEl) return;
  mcpBadgesEl.innerHTML = '';
  mcpServers.forEach(function(s) {
    var b = document.createElement('span');
    b.className = 'mcp-badge ' + (s.status || 'stopped');
    var tooltip = s.name + ' — ' + s.status;
    if (s.serverInfo && s.serverInfo.name) tooltip += ' (' + s.serverInfo.name + (s.serverInfo.version ? ' ' + s.serverInfo.version : '') + ')';
    if (s.status === 'ready') tooltip += ' · ' + (s.toolCount || 0) + ' tools';
    if (s.error) tooltip += ' — ' + s.error;
    b.title = tooltip;
    var count = s.status === 'ready' && s.toolCount > 0 ? ' · ' + s.toolCount : '';
    b.innerHTML = '<span class="mcp-dot"></span>' + esc(s.name) + count;
    b.addEventListener('click', function(e) { e.stopPropagation(); toggleMcpPanel(); });
    mcpBadgesEl.appendChild(b);
  });
  if (mcpPanelOpen) renderMcpPanel();
}

function renderMcpPanel() {
  if (!mcpPanelEl) return;
  mcpPanelEl.innerHTML = '';
  if (mcpServers.length === 0) {
    mcpPanelEl.innerHTML = '<div class="mcp-panel-empty">Sin servidores MCP configurados</div>';
    return;
  }
  mcpServers.forEach(function(s) {
    var block = document.createElement('div');
    block.className = 'mcp-panel-server';
    var head = '<div class="mcp-panel-server-head"><span>' + esc(s.name) + '</span>' +
      '<span class="status-pill ' + (s.status || 'stopped') + '">' + (s.status || 'stopped') + '</span></div>';
    var body = '';
    if (s.error) body += '<div class="mcp-panel-error">' + esc(s.error) + '</div>';

    // Tools
    if (s.tools && s.tools.length > 0) {
      body += '<div class="mcp-section-label">Herramientas</div>';
      body += s.tools.map(function(t) {
        return '<div class="mcp-tool-row" title="' + esc(t.description || t.name) + '">' +
          '<span class="mcp-tool-name">' + esc(t.name) + '</span>' +
          (t.description ? '<span class="mcp-tool-desc">' + esc(t.description) + '</span>' : '') +
          '</div>';
      }).join('');
    } else if (s.status === 'ready') {
      body += '<div class="mcp-panel-empty">Sin tools</div>';
    }

    // Resources
    if (s.resources && s.resources.length > 0) {
      body += '<div class="mcp-section-label" style="margin-top:6px">Recursos</div>';
      body += s.resources.map(function(r) {
        var srvName = esc(s.name); var rUri = esc(r.uri); var rName = esc(r.name);
        return '<div class="mcp-tool-row" style="cursor:pointer" title="' + rUri + '" onclick="attachMcpResource(\'' + srvName + '\',\'' + rUri + '\',\'' + rName + '\')">' +
          '<i class="codicon codicon-file-text" style="opacity:.6;font-size:11px"></i>' +
          '<span class="mcp-tool-name">' + rName + '</span>' +
          (r.description ? '<span class="mcp-tool-desc">' + esc(r.description) + '</span>' : '') +
          '<span style="font-size:10px;opacity:.4;margin-left:auto">adjuntar</span>' +
          '</div>';
      }).join('');
    }

    // Prompts
    if (s.prompts && s.prompts.length > 0) {
      body += '<div class="mcp-section-label" style="margin-top:6px">Prompts</div>';
      body += s.prompts.map(function(p) {
        var srvName = esc(s.name); var pName = esc(p.name);
        return '<div class="mcp-tool-row" style="cursor:pointer" title="' + esc(p.description || p.name) + '" onclick="invokeMcpPrompt(\'' + srvName + '\',\'' + pName + '\')">' +
          '<i class="codicon codicon-zap" style="opacity:.6;font-size:11px"></i>' +
          '<span class="mcp-tool-name">' + pName + '</span>' +
          (p.description ? '<span class="mcp-tool-desc">' + esc(p.description) + '</span>' : '') +
          '<span style="font-size:10px;opacity:.4;margin-left:auto">usar</span>' +
          '</div>';
      }).join('');
    }

    block.innerHTML = head + body;
    mcpPanelEl.appendChild(block);
  });
}

function toggleMcpPanel() {
  mcpPanelOpen = !mcpPanelOpen;
  if (!mcpPanelEl) return;
  if (mcpPanelOpen) {
    renderMcpPanel();
    mcpPanelEl.classList.add('open');
    vscode.postMessage({ type: 'requestMcpStatus' });
  } else {
    mcpPanelEl.classList.remove('open');
  }
}

document.addEventListener('click', function(e) {
  if (!mcpPanelOpen) return;
  if (e.target.closest && (e.target.closest('#mcp-panel') || e.target.closest('#mcp-badges'))) return;
  mcpPanelOpen = false;
  if (mcpPanelEl) mcpPanelEl.classList.remove('open');
});

/* ── Export menu ───────────────────────────────────────────── */
expB.addEventListener('click', function(e) {
  e.stopPropagation();
  expMenu.classList.toggle('open');
});
document.addEventListener('click', function() { expMenu.classList.remove('open'); });
document.getElementById('export-current').addEventListener('click', function() {
  vscode.postMessage({ type: 'exportChat' });
  expMenu.classList.remove('open');
});
document.getElementById('export-all').addEventListener('click', function() {
  vscode.postMessage({ type: 'exportAll' });
  expMenu.classList.remove('open');
});

/* ── Clear ─────────────────────────────────────────────────── */
clearB.addEventListener('click', function() {
  if (!confirm('¿Limpiar esta conversación?')) return;
  msgs.innerHTML = '';
  if (welc) { welc.style.display = ''; msgs.appendChild(welc); }
  vscode.postMessage({ type: 'clearHistory' });
});

/* ── Markdown renderer ─────────────────────────────────────── */
function renderMD(text) {
  codeBlocks = [];
  var lines = text.split('\\n');
  var html = '';
  var inCode = false;
  var codeBuf = '';
  var codeLang = '';
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (!inCode && ln.substring(0,3) === '\`\`\`') {
      inCode = true; codeLang = ln.substring(3).trim(); codeBuf = ''; continue;
    }
    if (inCode && ln.substring(0,3) === '\`\`\`') {
      inCode = false; html += codeBlock(codeBuf, codeLang, false); continue;
    }
    if (inCode) { codeBuf += (codeBuf ? '\\n' : '') + ln; continue; }
    html += renderLine(ln);
  }
  if (inCode) html += codeBlock(codeBuf, codeLang, true);
  return html;
}

function renderLine(ln) {
  if (!ln.trim()) return '<br>';
  if (ln.substring(0,4) === '### ') return '<h3>' + inl(ln.substring(4)) + '</h3>';
  if (ln.substring(0,3) === '## ')  return '<h2>' + inl(ln.substring(3)) + '</h2>';
  if (ln.substring(0,2) === '# ')   return '<h1>' + inl(ln.substring(2)) + '</h1>';
  if (ln.substring(0,2) === '> ')   return '<blockquote>' + inl(ln.substring(2)) + '</blockquote>';
  if (ln.substring(0,3) === '---' && ln.trim().replace(/-/g,'') === '') return '<hr>';
  var ulM = ln.match(/^[-*] (.+)/);
  if (ulM) return '<div class="li">' + inl(ulM[1]) + '</div>';
  var olM = ln.match(/^(\\d+)\\. (.+)/);
  if (olM) return '<div class="li">' + olM[1] + '. ' + inl(olM[2]) + '</div>';
  return '<div class="line">' + inl(ln) + '</div>';
}

function inl(t) {
  t = esc(t);
  t = t.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  t = t.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  t = t.replace(/~~(.+?)~~/g, '<del>$1</del>');
  t = t.replace(/\`([^\`]+)\`/g, '<code class="il">$1</code>');
  t = t.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" title="$2">$1</a>');
  return t;
}

function esc(t) {
  var d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

/* ── Code blocks ───────────────────────────────────────────── */
var codeBlockAlts = {};   // idx → [alt1, alt2, ...]
var codeBlockTab  = {};   // idx → current tab (0=original, 1=alt1, ...)

function codeBlock(code, lang, isStreaming) {
  var idx = codeBlocks.length;
  codeBlocks.push(code);
  var altBtn = (isStreaming || currentProvider === 'local') ? '' :
    '<button id="alt-btn-' + idx + '" onclick="requestAlt(' + idx + ',this)" title="Generar alternativa"><i class="codicon codicon-refresh"></i> Alt</button>';
  var acts = isStreaming ? '' :
    '<button onclick="cpB(' + idx + ',this)" title="Copiar"><i class="codicon codicon-copy"></i> Copiar</button>' +
    '<button onclick="insB(' + idx + ')" title="Insertar en cursor"><i class="codicon codicon-go-to-file"></i> Insertar</button>' +
    '<button onclick="diffB(' + idx + ')" title="Ver diff y aplicar"><i class="codicon codicon-diff"></i> Aplicar</button>' +
    altBtn;
  return '<div class="cb' + (isStreaming ? ' streaming' : '') + '" id="cb-' + idx + '">' +
    '<div class="cb-head"><span class="cb-lang">' + (lang || 'code') + '</span>' +
    '<span id="cb-tabs-' + idx + '" class="cb-tabs"></span>' +
    '<div class="cb-acts">' + acts + '</div></div>' +
    '<div id="cb-code-' + idx + '"><pre><code>' + hlCode(code, lang) + '</code></pre></div>' +
  '</div>';
}

function requestAlt(idx, btn) {
  btn.disabled = true;
  btn.innerHTML = '<i class="codicon codicon-loading codicon-modifier-spin"></i>';
  vscode.postMessage({ type: 'requestAlternative', code: codeBlocks[idx], blockIdx: idx });
}

function showAltTabs(idx) {
  var tabsEl = document.getElementById('cb-tabs-' + idx);
  if (!tabsEl) return;
  var alts = codeBlockAlts[idx] || [];
  var html = '<button class="cb-tab' + (codeBlockTab[idx] === 0 ? ' active' : '') + '" onclick="switchTab(' + idx + ',0)">❶</button>';
  for (var i = 0; i < alts.length; i++) {
    var num = ['❷','❸','❹'][i] || (i+2)+'';
    html += '<button class="cb-tab' + (codeBlockTab[idx] === i+1 ? ' active' : '') + '" onclick="switchTab(' + idx + ',' + (i+1) + ')">' + num + '</button>';
  }
  tabsEl.innerHTML = html;
}

function switchTab(idx, tab) {
  codeBlockTab[idx] = tab;
  var codeEl = document.getElementById('cb-code-' + idx);
  if (!codeEl) return;
  var code = tab === 0 ? codeBlocks[idx] : (codeBlockAlts[idx] || [])[tab - 1];
  if (code === undefined) return;
  codeEl.innerHTML = '<pre><code>' + hlCode(code, '') + '</code></pre>';
  showAltTabs(idx);
}

function cpB(idx, btn) {
  var tab = codeBlockTab[idx] || 0;
  var code = tab === 0 ? codeBlocks[idx] : (codeBlockAlts[idx] || [])[tab - 1];
  navigator.clipboard.writeText(code || codeBlocks[idx]).then(function() {
    btn.innerHTML = '<i class="codicon codicon-pass"></i> Copiado';
    btn.classList.add('ok');
    setTimeout(function() { btn.innerHTML = '<i class="codicon codicon-copy"></i> Copiar'; btn.classList.remove('ok'); }, 1500);
  });
}
function insB(idx) {
  var tab = codeBlockTab[idx] || 0;
  var code = tab === 0 ? codeBlocks[idx] : ((codeBlockAlts[idx] || [])[tab - 1] || codeBlocks[idx]);
  vscode.postMessage({ type: 'insertCode', code: code });
}
function diffB(idx) {
  var tab = codeBlockTab[idx] || 0;
  var code = tab === 0 ? codeBlocks[idx] : ((codeBlockAlts[idx] || [])[tab - 1] || codeBlocks[idx]);
  vscode.postMessage({ type: 'applyDiff', code: code });
}

/* ── Syntax highlighting ───────────────────────────────────── */
function hlCode(code, lang) {
  code = esc(code);
  var kwMap = {
    'javascript':'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|import|export|from|default|async|await|try|catch|throw|finally|new|typeof|instanceof|of|in|this|super|extends|yield|static|get|set|null|undefined|true|false|void',
    'typescript':'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|import|export|from|default|async|await|try|catch|throw|finally|new|typeof|instanceof|of|in|this|super|extends|yield|static|get|set|null|undefined|true|false|void|interface|type|enum|declare|namespace|abstract|readonly|keyof|infer|as|is|string|number|boolean|any|never|unknown',
    'python':'def|class|import|from|return|if|elif|else|for|while|try|except|finally|raise|with|as|lambda|yield|pass|break|continue|and|or|not|is|in|True|False|None|self|print|async|await',
    'go':'func|return|if|else|for|range|switch|case|default|break|continue|var|const|type|struct|interface|map|chan|go|defer|select|package|import|nil|true|false|error|string|int|bool'
  };
  var alias = { 'js':'javascript','ts':'typescript','tsx':'typescript','jsx':'javascript','py':'python','golang':'go' };
  var eLang = alias[lang] || lang || 'javascript';
  var kw = kwMap[eLang] || kwMap['javascript'];
  var result = code.split('\\n').map(function(line) {
    var commentIdx = eLang === 'python' ? line.indexOf('#') : line.indexOf('//');
    var main = commentIdx >= 0 ? line.substring(0, commentIdx) : line;
    var cmPart = commentIdx >= 0 ? '<span class="hl-cm">' + line.substring(commentIdx) + '</span>' : '';
    if (kw) main = main.replace(new RegExp('\\\\b(' + kw + ')\\\\b', 'g'), '<span class="hl-kw">$1</span>');
    main = main.replace(/\\b(\\d+\\.?\\d*)\\b/g, '<span class="hl-nm">$1</span>');
    main = main.replace(/\\b([A-Z][a-zA-Z0-9]+)\\b/g, '<span class="hl-tp">$1</span>');
    return main + cmPart;
  }).join('\\n');
  return result;
}

/* ── UI helpers ────────────────────────────────────────────── */
function addMsg(role, text) {
  hideWelcome();
  var div = document.createElement('div');
  div.className = 'msg ' + role;
  var avatar = role === 'user' ? '<i class="codicon codicon-account"></i>' : '<i class="codicon codicon-hubot"></i>';
  var label  = role === 'user' ? 'Tú' : 'ApliArte AI';
  div.innerHTML = '<div class="msg-hdr"><span>' + avatar + '</span> ' + label + '</div>' +
    '<div class="msg-body">' + (role === 'user' ? esc(text) : renderMD(text)) + '</div>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function hideWelcome() { if (welc) { welc.style.display = 'none'; } }

function updateWC() {
  var w = input.value.trim().split(/\\s+/).filter(function(x){return x;}).length;
  wcEl.textContent = w + ' palabra' + (w !== 1 ? 's' : '');
}

/* ── Send ──────────────────────────────────────────────────── */
function send() {
  var text = input.value.trim();
  if (!text || streaming) return;
  addMsg('user', text);
  input.value = '';
  input.style.height = 'auto';
  updateWC();
  vscode.postMessage({ type: 'sendMessage', text: text });
}

sendB.addEventListener('click', send);
input.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener('input', function() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  updateWC();
});
stopB.addEventListener('click', function() { vscode.postMessage({ type: 'stopGeneration' }); });
attB.addEventListener('click', function() { reqCtx('file'); });
function reqCtx(scope) { vscode.postMessage({ type: 'requestContext', scope: scope }); }
ctxRm.addEventListener('click', function() { ctxBar.classList.remove('on'); vscode.postMessage({ type: 'removeContext' }); });

/* ── Model/Provider ─────────────────────────────────────────── */
mSel.addEventListener('change', function() {
  var val = mSel.value;
  if (val.startsWith('download:')) {
    var modelId = val.substring(9);
    vscode.postMessage({ type: 'downloadModel', model: modelId });
    if (mSel.dataset.prev) mSel.value = mSel.dataset.prev;
  } else {
    mSel.dataset.prev = val;
    vscode.postMessage({ type: 'setModel', model: val });
  }
});
pSel.addEventListener('change', function() {
  currentProvider = pSel.value;
  updateFolderBtnVisibility(pSel.value);
  vscode.postMessage({ type: 'setProvider', provider: pSel.value });
});
tempIn.addEventListener('input', function() {
  tempV.textContent = parseFloat(tempIn.value).toFixed(1);
  vscode.postMessage({ type: 'setTemperature', value: parseFloat(tempIn.value) });
});

/* ── Welcome screen contextual ─────────────────────────────── */
var welcomeGuide   = document.getElementById('welcome-guide');
var welcomeDlBtn   = document.getElementById('welcome-dl-btn');
var welcomeSub     = document.getElementById('welcome-sub');

var GUIDE_TEXTS = {
  'local-needs-folder': {
    sub: 'Modo local — primero configurá tu carpeta de modelos',
    guide: '📁 <strong>¿Dónde guardás tus modelos?</strong><br>Elegí la carpeta donde están tus modelos descargados (disco externo, tarjeta SD, o cualquier carpeta local). La extensión los buscará ahí automáticamente.',
    showBtn: false,
    showFolderBtn: true,
  },
  'local-needs-download': {
    sub: 'Modo local — inferencia en tu máquina, sin internet',
    guide: '⬇️ <strong>Primer paso:</strong> descargá el modelo Qwen 2.5 (0.5B, ~350MB).<br>Solo la primera vez — después carga en segundos.',
    showBtn: true,
    showFolderBtn: false,
  },
  'local-ready': {
    sub: 'Modelo local listo — podés escribir tu primer mensaje',
    guide: '✅ <strong>Todo listo.</strong> El modelo está cargado en memoria. Escribí tu pregunta abajo.',
    showBtn: false, showFolderBtn: false,
  },
  'remote-offline': {
    sub: 'LM Studio / Ollama — no detectado',
    guide: '⚠️ <strong>No hay modelo detectado.</strong><br>Opciones:<br>• Abrí <strong>LM Studio</strong> o <strong>Ollama</strong> y cargá un modelo<br>• O cambiá el proveedor a <strong>Local</strong> para inferencia sin instalar nada',
    showBtn: false, showFolderBtn: false,
  },
  'remote-ready': {
    sub: 'Conectado — podés escribir tu primer mensaje',
    guide: '', showBtn: false, showFolderBtn: false,
  },
  'agent': {
    sub: 'Agent Cloud — verificá la conexión en Configuración',
    guide: '☁️ <strong>Modo Agente.</strong> Configurá el endpoint y la API key en <i class="codicon codicon-settings-gear"></i> Configuración.',
    showBtn: false, showFolderBtn: false,
  },
};

var welcomeFolderBtn = document.getElementById('welcome-folder-btn');

function updateWelcomeForProvider(state) {
  var cfg = GUIDE_TEXTS[state];
  if (!cfg) return;
  if (welcomeSub)   welcomeSub.textContent = cfg.sub;
  if (welcomeGuide) {
    if (cfg.guide) {
      welcomeGuide.innerHTML = cfg.guide;
      welcomeGuide.style.display = 'block';
    } else {
      welcomeGuide.style.display = 'none';
    }
  }
  if (welcomeDlBtn)     welcomeDlBtn.style.display     = cfg.showBtn       ? 'block' : 'none';
  if (welcomeFolderBtn) welcomeFolderBtn.style.display  = cfg.showFolderBtn ? 'block' : 'none';
}

function triggerAutoDownload() {
  vscode.postMessage({ type: 'downloadModel', model: 'onnx-community/Qwen2.5-0.5B-Instruct' });
  if (welcomeDlBtn) welcomeDlBtn.style.display = 'none';
  if (welcomeGuide) { welcomeGuide.innerHTML = '⏳ <strong>Descargando…</strong> Esto puede tardar unos minutos. Mirá la barra de progreso arriba.'; }
}

/* ── Ready ─────────────────────────────────────────────────── */
vscode.postMessage({ type: 'webviewReady' });
setInterval(function() { vscode.postMessage({ type: 'checkConnection' }); }, 15000);

/* ── Messages from extension ───────────────────────────────── */
window.addEventListener('message', function(event) {
  var d = event.data;
  switch (d.type) {

    case 'responseStart':
      streaming = true; sendB.style.display = 'none'; stopB.style.display = 'flex';
      rawText = ''; hideWelcome();
      curEl = document.createElement('div');
      curEl.className = 'msg assistant';
      curEl.innerHTML = '<div class="msg-hdr"><span><i class="codicon codicon-hubot"></i></span> ApliArte AI</div>' +
        '<div class="msg-body"><span class="thinking">Pensando<span class="d">.</span><span class="d">.</span><span class="d">.</span></span></div>';
      msgs.appendChild(curEl); msgs.scrollTop = msgs.scrollHeight;
      break;

    case 'responseChunk':
      if (curEl) {
        rawText += d.text;
        var body = curEl.querySelector('.msg-body');
        body.innerHTML = renderMD(rawText) + '<span class="cursor"></span>';
        msgs.scrollTop = msgs.scrollHeight;
      }
      break;

    case 'toolCallBlock':
      renderToolBlock(d);
      break;

    case 'responseEnd':
      streaming = false; sendB.style.display = 'flex'; stopB.style.display = 'none';
      if (curEl) { curEl.querySelector('.msg-body').innerHTML = renderMD(rawText); }
      curEl = null; rawText = ''; input.focus();
      break;

    case 'responseStopped':
      streaming = false; sendB.style.display = 'flex'; stopB.style.display = 'none';
      if (curEl) { curEl.querySelector('.msg-body').innerHTML = renderMD(rawText) +
        '<div style="margin-top:6px;font-size:11px;opacity:.5;font-style:italic;"><i class="codicon codicon-debug-stop"></i> Generación detenida</div>'; }
      curEl = null; rawText = ''; input.focus();
      break;

    case 'responseError':
      streaming = false; sendB.style.display = 'flex'; stopB.style.display = 'none';
      var errHtml = '<div style="color:var(--vscode-errorForeground)"><i class="codicon codicon-warning"></i> ' + esc(d.text) + '</div>' +
        '<div style="margin-top:4px;font-size:11px;opacity:.55;">Verificá la conexión o los ajustes de la extensión.</div>';
      if (curEl) { curEl.querySelector('.msg-body').innerHTML = errHtml; }
      else {
        hideWelcome();
        var errDiv = document.createElement('div'); errDiv.className = 'msg assistant';
        errDiv.innerHTML = '<div class="msg-hdr"><span><i class="codicon codicon-warning"></i></span> Error</div><div class="msg-body">' + errHtml + '</div>';
        msgs.appendChild(errDiv); msgs.scrollTop = msgs.scrollHeight;
      }
      curEl = null; rawText = ''; input.focus();
      break;

    case 'cleared':
      msgs.innerHTML = '';
      if (welc) { welc.style.display = ''; msgs.appendChild(welc); }
      break;

    case 'conversationList':
      renderConversations(d.conversations, d.activeId);
      activeConvId = d.activeId;
      break;

    case 'restoreHistory':
      if (d.messages && d.messages.length > 0) {
        hideWelcome();
        d.messages.forEach(function(m) {
          if (m.role === 'user' || m.role === 'assistant') addMsg(m.role, m.content);
        });
      }
      break;

    case 'settingsLoaded':
      if (d.settings) {
        applyLang(d.settings.language || 'es');
        document.getElementById('s-preset').value   = d.settings.preset || 'minimal';
        document.getElementById('s-language').value = d.settings.language || 'es';
        document.getElementById('s-lmstudio').value = d.settings.lmstudioEndpoint || '';
        document.getElementById('s-ollama').value   = d.settings.ollamaEndpoint || '';
        document.getElementById('s-agent').value    = d.settings.agentEndpoint || '';
        document.getElementById('s-apikey').value    = d.settings.agentApiKey || '';
        updateModelsDirCard(d.settings.modelsDir || '');
        // Update welcome screen badge
        var modelsDirBadge = document.getElementById('models-dir-badge');
        if (modelsDirBadge) {
          if (d.settings.modelsDir) {
            modelsDirBadge.textContent = '📁 ' + d.settings.modelsDir;
            modelsDirBadge.style.display = 'block';
          } else {
            modelsDirBadge.style.display = 'none';
          }
        }
      }
      break;

    case 'settingsSaved':
      break;

    case 'mcpStatus':
      renderMcpBadges(d.servers || []);
      break;

    case 'modelsLoaded':
      mSel.innerHTML = '';
      if (d.agentMode) {
        var agOpt = document.createElement('option');
        agOpt.value = 'agent-default'; agOpt.textContent = 'Modelo del servidor'; agOpt.selected = true;
        mSel.appendChild(agOpt); mSel.disabled = true;
        updateWelcomeForProvider('agent');
      } else if (d.needsModelsDir) {
        mSel.disabled = true;
        var folderOpt = document.createElement('option');
        folderOpt.value = ''; folderOpt.textContent = 'Elegí carpeta primero'; folderOpt.selected = true;
        mSel.appendChild(folderOpt);
        updateFolderBtnVisibility('local');
        updateWelcomeForProvider('local-needs-folder');
      } else if (d.localCatalog && d.localCatalog.length > 0) {
        mSel.disabled = false;
        updateFolderBtnVisibility('local');
        if (d.loadedModel) {
          var lOpt = document.createElement('option');
          lOpt.value = d.loadedModel; lOpt.textContent = d.loadedModel.split('/').pop() + ' (cargado)'; lOpt.selected = true;
          mSel.appendChild(lOpt); mSel.dataset.prev = d.loadedModel;
          updateWelcomeForProvider('local-ready');
        } else {
          updateWelcomeForProvider('local-needs-download');
        }
        // ── ONNX models found on disk (loadable locally) ──
        if (d.scannedModels && d.scannedModels.length > 0) {
          var scanSep = document.createElement('option'); scanSep.disabled = true;
          scanSep.textContent = '── En tu carpeta (ONNX) ──'; mSel.appendChild(scanSep);
          d.scannedModels.forEach(function(id) {
            if (id === d.loadedModel) return;
            var opt = document.createElement('option');
            opt.value = 'download:' + id; opt.textContent = '📂 ' + id.split('/').pop();
            mSel.appendChild(opt);
          });
        }
        // ── GGUF models found on disk (informational — use via LM Studio) ──
        if (d.ggufModels && d.ggufModels.length > 0) {
          var ggufSep = document.createElement('option'); ggufSep.disabled = true;
          ggufSep.textContent = '── En tu carpeta (GGUF · usa vía LM Studio) ──'; mSel.appendChild(ggufSep);
          d.ggufModels.forEach(function(id) {
            var opt = document.createElement('option');
            opt.value = ''; opt.disabled = true;
            opt.textContent = '🟠 ' + id.split('/').pop();
            mSel.appendChild(opt);
          });
        }
        // ── Catalog (download options) ──
        var sep = document.createElement('option'); sep.disabled = true; sep.textContent = '── Descargar modelo ──'; mSel.appendChild(sep);
        d.localCatalog.forEach(function(m) {
          if (m.id === d.loadedModel) return;
          var opt = document.createElement('option');
          opt.value = 'download:' + m.id; opt.textContent = m.label + ' (' + m.size + ')' + (m.recommended ? ' ★' : '');
          mSel.appendChild(opt);
        });
        if (!d.loadedModel && (!d.scannedModels || d.scannedModels.length === 0)) {
          var hint = document.createElement('option'); hint.value = ''; hint.textContent = 'Seleccioná un modelo para descargar'; hint.selected = true;
          mSel.prepend(hint);
        }
      } else if (d.models && d.models.length > 0) {
        mSel.disabled = false;
        d.models.forEach(function(m) {
          var opt = document.createElement('option');
          opt.value = m; opt.textContent = m;
          if (d.selected && m === d.selected) opt.selected = true;
          mSel.appendChild(opt);
        });
        updateWelcomeForProvider('remote-ready');
      } else {
        var noOpt = document.createElement('option'); noOpt.value = ''; noOpt.textContent = 'Sin modelos — abrí LM Studio';
        mSel.appendChild(noOpt);
        updateWelcomeForProvider('remote-offline');
      }
      break;

    case 'connectionStatus':
      currentProvider = d.provider || currentProvider;
      updateFolderBtnVisibility(currentProvider);
      if (d.provider === 'agent') {
        dot.classList.toggle('on', d.connected); stTxt.textContent = d.connected ? 'Agent' : 'Agent offline';
      } else if (d.provider === 'local') {
        dot.classList.toggle('on', d.connected); stTxt.textContent = d.connected ? 'Local' : 'Sin modelo';
      } else {
        dot.classList.toggle('on', d.connected); stTxt.textContent = d.connected ? (d.name || 'Online') : 'Offline';
      }
      break;

    case 'downloadStart':
      dlBar.style.display = 'block'; dlFill.style.width = '0%';
      dlText.textContent = 'Descargando ' + (d.model ? d.model.split('/').pop() : 'modelo') + '…';
      break;
    case 'downloadProgress':
      dlBar.style.display = 'block';
      if (d.status === 'progress') {
        if (typeof d.progress === 'number') {
          dlFill.style.width = Math.round(d.progress) + '%';
          dlText.textContent = 'Descargando' + (d.file ? ' ' + d.file.split('/').pop() : '') + '… ' + Math.round(d.progress) + '%';
        } else if (d.file) {
          dlFill.style.width = '100%';
          dlText.textContent = d.file;
        }
      } else if (d.status === 'done') { 
        dlFill.style.width = '100%'; 
      } else if (d.status === 'download' || d.status === 'initiate' || d.status === 'ready') {
        dlFill.style.width = '0%';
        dlText.textContent = 'Preparando ' + (d.file ? d.file.split('/').pop() : '') + '…';
      }
      break;
    case 'downloadComplete': dlBar.style.display = 'none'; dlFill.style.width = '0%'; break;
    case 'downloadError':    
      dlBar.style.display = 'none'; dlFill.style.width = '0%'; 
      if (welcomeGuide) { welcomeGuide.innerHTML = '❌ <strong>Error:</strong> ' + esc(d.text); }
      break;
    case 'modelUnloaded': break;

    case 'hfResults':
      renderHfResults(d.models, d.error);
      break;

    case 'inferenceStats':
      showInferenceStats(d.tokensPerSecond, d.suggestedModel);
      break;

    case 'alternativeLoading': {
      var altBtn2 = document.getElementById('alt-btn-' + d.blockIdx);
      if (altBtn2) { altBtn2.disabled = true; altBtn2.innerHTML = '<i class="codicon codicon-loading codicon-modifier-spin"></i>'; }
      break;
    }
    case 'alternativeReady': {
      if (!codeBlockAlts[d.blockIdx]) codeBlockAlts[d.blockIdx] = [];
      if (codeBlockAlts[d.blockIdx].length < 3) {
        codeBlockAlts[d.blockIdx].push(d.code);
        codeBlockTab[d.blockIdx] = codeBlockAlts[d.blockIdx].length;
        switchTab(d.blockIdx, codeBlockTab[d.blockIdx]);
      }
      var altBtn3 = document.getElementById('alt-btn-' + d.blockIdx);
      if (altBtn3) {
        altBtn3.disabled = codeBlockAlts[d.blockIdx].length >= 3;
        altBtn3.innerHTML = '<i class="codicon codicon-refresh"></i> Alt';
      }
      break;
    }
    case 'alternativeError': {
      var altBtn4 = document.getElementById('alt-btn-' + d.blockIdx);
      if (altBtn4) { altBtn4.disabled = false; altBtn4.innerHTML = '<i class="codicon codicon-refresh"></i> Alt'; }
      break;
    }

    case 'contextAttached':
      ctxBar.classList.add('on');
      ctxI.innerHTML = '<i class="codicon codicon-pin"></i> ' + d.name + (d.preview ? ' — ' + d.preview.substring(0,60) + '…' : '');
      break;
    case 'contextRemoved': case 'contextError': ctxBar.classList.remove('on'); break;

    case 'autoSend': input.value = d.text; send(); break;
  }
});

input.focus();
</script>
</body>
</html>`;
  }
}
