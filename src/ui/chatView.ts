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
  scanOllamaModels,
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
        this._post({ type: 'responseError', text: 'No hay modelo cargado. Abre LM Studio u Ollama, carga un modelo e inténtalo de nuevo.' });
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
      const ollamaModels = scanOllamaModels().map((m) => m.id);

      this._post({
        type: 'modelsLoaded',
        models: allModels.map((m) => m.id),
        selected: this._currentModel ?? '',
        localCatalog: AVAILABLE_MODELS,
        scannedModels: scannedOnnx,
        ggufModels: scannedGguf,
        ollamaModels,
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
    const name = endpoint.includes('11434') ? 'Ollama' : endpoint.includes('1337') ? 'Jan' : 'LM Studio';
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
      checkConnection('http://localhost:1337/v1'),
    ]);

    const lmOk     = results[0].status === 'fulfilled' && results[0].value;
    const ollamaOk = results[1].status === 'fulfilled' && results[1].value;
    const janOk    = results[2].status === 'fulfilled' && results[2].value;

    if (lmOk) {
      this._remoteEndpoint = lmstudio;
    } else if (ollamaOk) {
      this._remoteEndpoint = ollamaV1;
    } else if (janOk) {
      this._remoteEndpoint = 'http://localhost:1337/v1';
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
      vscode.window.showWarningMessage('No hay editor activo. Abre el archivo donde quieres aplicar el cambio.');
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
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js')
    );
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${cssUri}">
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
          <p style="margin-top:8px;font-size:11px;opacity:.55;" data-i18n="welcome_folder_hint">Apunta a donde tienes tus modelos descargados (disco externo, tarjeta SD, etc.)</p>
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
        <p class="settings-hint" style="margin-bottom:8px;" data-i18n="s_models_dir_desc">Elige dónde guardas tus modelos de IA. Puede ser un disco externo, una tarjeta SD o cualquier carpeta. Los buscará ahí automáticamente.</p>
        <div id="models-dir-card">
          <div class="dir-path empty" id="models-dir-display" data-i18n="s_models_dir_none">Sin carpeta configurada (usa almacenamiento por defecto)</div>
          <input type="hidden" id="s-modelsdir">
          <button class="change-dir-btn" onclick="vscode.postMessage({type:'chooseModelsDir'})">
            <i class="codicon codicon-folder-opened"></i> <span data-i18n="s_choose_dir_big">Cambiar carpeta de modelos</span>
          </button>
          <div id="move-models-helper">
            <p data-i18n="s_move_models_info">¿Tienes modelos en otro lugar? Da este prompt al Agente para que los mueva:</p>
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
            <p data-i18n="agent_info_1">Necesitas tu propio servidor para usar el modo Agente. Es el backend que habla con el LLM en la nube por ti.</p>
            <p data-i18n="agent_info_2">La forma más fácil es desplegarlo en Hostinger (VPS desde €4/mes):</p>
            <button class="host-btn" onclick="openUrl('https://www.hostinger.com/es?REFERRALCODE=APLIARTE')">
              🚀 <span data-i18n="agent_hostinger">Abrir Hostinger (descuento incluido)</span>
            </button>
            <p style="margin-top:8px;" data-i18n="agent_info_3">O sigue la guía del repositorio para instalar el backend en cualquier servidor.</p>
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
        <p class="settings-hint" style="margin-bottom:8px;" data-i18n="s_mcp_local_desc">Conecta servidores MCP que corren en tu máquina — sin internet, 100% privado.</p>
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
          <button class="mcp-preset-btn" onclick="addMcpPreset('github')">
            <span class="preset-icon">🐙</span>
            <div>
              <div>GitHub</div>
              <div class="mcp-preset-desc">Issues, PRs y búsqueda de código. Requiere un Personal Access Token.</div>
            </div>
          </button>
          <button class="mcp-preset-btn" onclick="addMcpPreset('postgres')">
            <span class="preset-icon">🐘</span>
            <div>
              <div>PostgreSQL</div>
              <div class="mcp-preset-desc">Consultas SQL sobre tu base de datos local o remota.</div>
            </div>
          </button>
          <button class="mcp-preset-btn" onclick="addMcpPreset('sqlite')">
            <span class="preset-icon">🗃️</span>
            <div>
              <div>SQLite</div>
              <div class="mcp-preset-desc">Consultas sobre un archivo .sqlite en tu proyecto.</div>
            </div>
          </button>
          <button class="mcp-preset-btn" onclick="addMcpPreset('playwright')">
            <span class="preset-icon">🎭</span>
            <div>
              <div>Browser (Playwright)</div>
              <div class="mcp-preset-desc">El agente puede navegar webs, hacer click y tomar screenshots.</div>
            </div>
          </button>
        </div>
        <div class="settings-hint" style="margin-top:6px;" data-i18n="s_mcp_local_hint">Requiere Node.js. Se agrega a apliarteAi.mcpServers automáticamente.</div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">🗂️ Plantillas de stack MCP</div>
        <p class="settings-hint" style="margin-bottom:8px;">Configura un conjunto de servidores MCP de una sola vez según tu stack.</p>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="mcp-preset-btn" onclick="applyMcpStack('node')"><span class="preset-icon">🟩</span><div><div>Node.js / TypeScript</div><div class="mcp-preset-desc">memory + filesystem + github</div></div></button>
          <button class="mcp-preset-btn" onclick="applyMcpStack('python')"><span class="preset-icon">🐍</span><div><div>Python</div><div class="mcp-preset-desc">memory + filesystem + postgres</div></div></button>
          <button class="mcp-preset-btn" onclick="applyMcpStack('go')"><span class="preset-icon">🐹</span><div><div>Go</div><div class="mcp-preset-desc">memory + filesystem + github</div></div></button>
          <button class="mcp-preset-btn" onclick="applyMcpStack('fullstack')"><span class="preset-icon">🌐</span><div><div>Full-stack web</div><div class="mcp-preset-desc">memory + filesystem + github + playwright</div></div></button>
        </div>
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

<script src="${jsUri}"></script>
</body>
</html>`;
  }
}
