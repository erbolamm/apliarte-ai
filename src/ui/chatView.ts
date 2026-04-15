import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import {
  streamChat,
  listModels,
  checkConnection,
  type ChatMessage,
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
} from '../core/localInference';
import {
  streamAgentChat,
  continueAfterToolCall,
  checkAgentConnection,
} from '../core/agentService';
import { executeTool } from '../tools/executor';
import { ConversationStore } from '../core/conversationStore';
import { getEngramService, resetEngramService } from '../core/engramService';

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

  constructor(
    private readonly _extensionUri: vscode.Uri,
    globalState: vscode.Memento,
  ) {
    this._globalState = globalState;
    this._store = new ConversationStore(globalState);
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

        // ── Engram ────────────────────────────────────────────────────────
        case 'engramSearch':
          await this._engramSearch(data.query, data.project);
          break;
        case 'engramSave':
          await this._engramSave(data.title, data.content, data.type, data.project);
          break;
        case 'checkEngram':
          await this._checkEngramStatus();
          break;

        // ── Context ───────────────────────────────────────────────────────
        case 'insertCode':
          await this._insertCode(data.code);
          break;
        case 'applyDiff':
          await this._applyDiff(data.code);
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
    await this._checkEngramStatus();
    this._sendSettings();
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
        preset:          cfg.get<string>('preset', 'minimal'),
        lmstudioEndpoint: cfg.get<string>('lmstudioEndpoint', 'http://localhost:1234/v1'),
        ollamaEndpoint:  cfg.get<string>('ollamaEndpoint', 'http://localhost:11434'),
        agentEndpoint:   cfg.get<string>('agentEndpoint', ''),
        agentApiKey:     cfg.get<string>('agentApiKey', ''),
        engramEndpoint:  cfg.get<string>('engramEndpoint', 'http://localhost:4200'),
        language:        cfg.get<string>('language', 'es'),
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
    if ('engramEndpoint' in settings)   await cfg.update('engramEndpoint', settings.engramEndpoint, target);
    if ('language' in settings)         await cfg.update('language', settings.language, target);

    // Reset caches that depend on config
    this._remoteEndpoint = undefined;
    resetEngramService();

    this._post({ type: 'settingsSaved' });
    vscode.window.showInformationMessage('ApliArte AI: Configuración guardada.');
    await this._sendConnectionStatus();
    await this._checkEngramStatus();
  }

  // ── Engram ─────────────────────────────────────────────────────────────────

  private async _checkEngramStatus(): Promise<void> {
    const svc = getEngramService();
    const available = await svc.isAvailable();
    this._post({ type: 'engramStatus', available });
  }

  private async _engramSearch(query: string, project?: string): Promise<void> {
    const svc = getEngramService();
    const results = await svc.search(query, project, 10);
    this._post({ type: 'engramResults', results, query });
  }

  private async _engramSave(
    title: string,
    content: string,
    type = 'discovery',
    project?: string
  ): Promise<void> {
    const svc = getEngramService();
    const id = await svc.save({ title, content, type, project });
    if (id !== undefined) {
      this._post({ type: 'engramSaved', id });
      vscode.window.showInformationMessage(`ApliArte AI: Memoria guardada en Engram (#${id})`);
    } else {
      vscode.window.showWarningMessage('ApliArte AI: No se pudo conectar con Engram.');
    }
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  private async _setProvider(provider: 'remote' | 'local' | 'agent'): Promise<void> {
    this._provider = provider;
    this._currentModel = undefined;
    this._remoteEndpoint = undefined;
    if (provider === 'local') {
      await this._ensureLocalDeps();
      if (!isModelLoaded()) {
        const recommended = AVAILABLE_MODELS.find((m) => m.recommended) ?? AVAILABLE_MODELS[0];
        if (recommended) {
          await this._downloadLocalModel(recommended.id);
        }
      }
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
        await streamChatLocal(messages, (chunk: string) => {
          fullResponse += chunk;
          this._post({ type: 'responseChunk', text: chunk });
        }, {
          signal: this._abortController.signal,
          temperature: this._temperature,
        });
      } else {
        const endpoint = await this._resolveRemoteEndpoint();
        await streamChat(endpoint, messages, (chunk: string) => {
          fullResponse += chunk;
          this._post({ type: 'responseChunk', text: chunk });
        }, {
          signal: this._abortController.signal,
          temperature: this._temperature,
          model: this._currentModel,
          timeoutMs: 60_000,
        });
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

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const isFirstCall = iteration === 0;
      const stream = isFirstCall
        ? streamAgentChat(endpoint, apiKey, currentMessages, {
            signal: this._abortController?.signal,
            temperature: this._temperature,
            workspaceId,
          })
        : continueAfterToolCall(endpoint, apiKey, currentMessages, {
            signal: this._abortController?.signal,
            temperature: this._temperature,
            workspaceId,
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
            this._post({
              type: 'responseChunk',
              text: `\n\n**Ejecutando ${tc.name}**...\n`,
            });
            fullResponse += `\n\n**Ejecutando ${tc.name}**...\n`;

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

            const preview = result.content.slice(0, 200);
            this._post({
              type: 'responseChunk',
              text: `\`\`\`\n${preview}${result.content.length > 200 ? '\n...' : ''}\n\`\`\`\n`,
            });
            fullResponse += `\`\`\`\n${preview}${result.content.length > 200 ? '\n...' : ''}\n\`\`\`\n`;
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
      const models = await listLocalModels();
      const loaded = getLoadedModel();
      this._currentModel = loaded ?? undefined;
      this._post({
        type: 'modelsLoaded',
        models: models.map((m) => m.id),
        selected: this._currentModel ?? '',
        localCatalog: AVAILABLE_MODELS,
        loadedModel: loaded,
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

  private async _ensureLocalDeps(): Promise<void> {
    try {
      if (areDepsInstalled()) return;
      this._post({ type: 'downloadStart', model: 'transformers.js' });
      await installDeps((msg) => {
        this._post({ type: 'downloadProgress', status: 'progress', model: 'transformers.js', file: msg });
      });
      this._post({ type: 'downloadComplete', model: 'transformers.js' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Error instalando dependencias';
      this._post({ type: 'downloadError', text: msg, model: 'transformers.js' });
      this._provider = 'remote';
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

  private async _downloadLocalModel(modelId: string): Promise<void> {
    this._post({ type: 'downloadStart', model: modelId });
    try {
      await loadModel(modelId, (info) => {
        this._post({ type: 'downloadProgress', ...info, model: modelId });
      });
      this._currentModel = modelId;
      this._post({ type: 'downloadComplete', model: modelId });
      await this._refreshModels();
      await this._sendConnectionStatus();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Error descargando modelo';
      this._post({ type: 'downloadError', text: msg, model: modelId });
    }
  }

  // ── Context ────────────────────────────────────────────────────────────────

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

/* ── Engram badge ──────────────────────────────────────── */
#engram-badge{
  font-size:9px;padding:1px 5px;border-radius:10px;
  background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
  white-space:nowrap;display:none;
}
#engram-badge.on{display:inline;background:#22c55e22;color:#22c55e;}

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

/* ── Engram panel ──────────────────────────────────────── */
#engram-overlay{
  display:none;position:absolute;inset:0;z-index:100;
  background:rgba(0,0,0,.6);backdrop-filter:blur(2px);
  align-items:flex-start;justify-content:center;padding-top:20px;
}
#engram-overlay.open{display:flex;}
#engram-panel{
  background:var(--vscode-editorWidget-background);
  border:1px solid var(--vscode-panel-border);border-radius:10px;
  width:calc(100% - 32px);max-width:380px;max-height:80vh;
  display:flex;flex-direction:column;
  box-shadow:0 8px 32px rgba(0,0,0,.4);animation:slideUp .2s ease;
}
#engram-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:12px 14px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;
}
#engram-header h3{font-size:13px;font-weight:700;}
#engram-header-right{display:flex;align-items:center;gap:6px;}
#engram-status-dot{width:7px;height:7px;border-radius:50%;background:#ef4444;flex-shrink:0;}
#engram-status-dot.on{background:#22c55e;box-shadow:0 0 5px #22c55e80;}
#engram-status-label{font-size:10px;opacity:.6;}
#engram-close{background:none;border:none;cursor:pointer;color:var(--vscode-foreground);opacity:.6;font-size:15px;padding:2px;}
#engram-close:hover{opacity:1;}
#engram-search-row{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;}
#engram-query{
  flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border);border-radius:5px;
  padding:5px 8px;font-size:12px;
}
#engram-query:focus{outline:none;border-color:var(--vscode-focusBorder);}
#engram-search-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:5px;padding:5px 10px;cursor:pointer;font-size:12px;}
#engram-search-btn:hover{filter:brightness(1.15);}
#engram-results{flex:1;overflow-y:auto;padding:6px 10px;}
.engram-result{
  padding:8px;border-radius:6px;margin-bottom:6px;cursor:pointer;
  background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);
  transition:border-color .15s;
}
.engram-result:hover{border-color:var(--vscode-button-background);}
.engram-result-title{font-size:12px;font-weight:600;margin-bottom:3px;}
.engram-result-content{font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.engram-result-meta{font-size:10px;opacity:.4;margin-top:3px;}
#engram-empty{padding:20px;text-align:center;font-size:11px;opacity:.4;font-style:italic;}
#engram-save-section{padding:8px 12px;border-top:1px solid var(--vscode-panel-border);flex-shrink:0;}
#engram-save-section details summary{font-size:11px;opacity:.6;cursor:pointer;padding:4px 0;}
#engram-save-title{width:100%;margin-bottom:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:5px;padding:5px 8px;font-size:12px;}
#engram-save-title:focus{outline:none;border-color:var(--vscode-focusBorder);}
#engram-save-content{width:100%;height:70px;resize:none;margin-bottom:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:5px;padding:5px 8px;font-size:12px;}
#engram-save-content:focus{outline:none;border-color:var(--vscode-focusBorder);}
#engram-save-btn{width:100%;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:5px;padding:6px;font-size:12px;cursor:pointer;}
#engram-save-btn:hover{filter:brightness(1.15);}

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
</style>
</head>
<body>

<!-- ── Toolbar ──────────────────────────────────────────── -->
<div id="toolbar">
  <button class="tb" id="sidebar-toggle" title="Conversaciones"><i class="codicon codicon-layout-sidebar-left"></i></button>
  <div id="status"><span class="dot" id="dot"></span><span id="st-text">…</span></div>
  <select id="provider-select" title="Proveedor">
    <option value="remote">LM Studio / Ollama</option>
    <option value="local">Local</option>
    <option value="agent">Agent</option>
  </select>
  <select id="model-select" title="Modelo"><option value="">cargando…</option></select>
  <span id="engram-badge" title="Engram conectado">🧠</span>
  <div style="position:relative">
    <button class="tb" id="export-btn" title="Exportar"><i class="codicon codicon-export"></i></button>
    <div id="export-menu">
      <div class="export-menu-item" id="export-current"><i class="codicon codicon-file"></i> Esta conversación</div>
      <div class="export-menu-item" id="export-all"><i class="codicon codicon-files"></i> Todas las conversaciones</div>
    </div>
  </div>
  <button class="tb" id="clear-btn" title="Limpiar chat"><i class="codicon codicon-trash"></i></button>
  <button class="tb" id="engram-btn" title="Engram — Memoria persistente"><i class="codicon codicon-library"></i></button>
  <button class="tb" id="settings-btn" title="Configuración"><i class="codicon codicon-settings-gear"></i></button>
</div>

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
      <span>Conversaciones</span>
      <button id="new-conv-btn" title="Nueva conversación">+ Nueva</button>
    </div>
    <div id="conv-list"><div id="conv-empty">Sin conversaciones</div></div>
  </div>

  <!-- ── Chat area ──────────────────────────────────────────── -->
  <div id="chat-area">

    <!-- ── Messages ──────────────────────────────────────────── -->
    <div id="messages">
      <div id="welcome">
        <div class="logo"><i class="codicon codicon-hubot"></i></div>
        <h2>ApliArte AI Chat</h2>
        <p class="sub" id="welcome-sub">100% local · 0 coste · Tus datos, tu máquina</p>
        <div id="welcome-guide" style="display:none;margin:10px 0 14px;padding:10px 14px;border-radius:8px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border);text-align:left;font-size:12px;max-width:280px;"></div>
        <div id="welcome-dl-btn" style="display:none;margin-bottom:12px;">
          <button id="auto-dl-btn" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:8px;padding:9px 18px;cursor:pointer;font-size:13px;font-weight:600;" onclick="triggerAutoDownload()"><i class="codicon codicon-cloud-download"></i> Descargar modelo recomendado (~350MB)</button>
          <p style="margin-top:6px;font-size:10px;opacity:.45;">Solo la primera vez. Se guarda localmente.</p>
        </div>
        <div class="qa">
          <button onclick="reqCtx('file')"><i class="codicon codicon-file"></i> Enviar archivo</button>
          <button onclick="reqCtx('selection')"><i class="codicon codicon-code"></i> Enviar selección</button>
        </div>
      </div>
    </div>

    <!-- ── Context bar ────────────────────────────────────────── -->
    <div id="ctx">
      <span><i class="codicon codicon-pin"></i></span><span class="info" id="ctx-info"></span>
      <button class="rm" id="ctx-rm" title="Quitar contexto">✕</button>
    </div>

    <!-- ── Input area ─────────────────────────────────────────── -->
    <div id="input-area">
      <div id="input-row">
        <button class="act-btn tb" id="attach-btn" title="Adjuntar archivo o selección"><i class="codicon codicon-pin"></i></button>
        <textarea id="input" rows="1" placeholder="Escribe tu mensaje…"></textarea>
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

<!-- ── Settings modal ─────────────────────────────────────── -->
<div id="settings-overlay">
  <div id="settings-panel">
    <div id="settings-header">
      <h3><i class="codicon codicon-settings-gear"></i> Configuración</h3>
      <button id="settings-close">✕</button>
    </div>
    <div id="settings-body">
      <div class="settings-section">
        <div class="settings-section-title">Comportamiento</div>
        <div class="settings-field">
          <label>Preset del sistema</label>
          <select id="s-preset">
            <option value="minimal">Minimal — Conciso, ideal &le;8B</option>
            <option value="ecosystem-only">Medium — SDD + Ecosystem, 13B-30B</option>
            <option value="full-gentleman">Full Gentleman — Todo, modelos grandes</option>
          </select>
        </div>
        <div class="settings-field">
          <label>Idioma</label>
          <select id="s-language">
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">LM Studio / Ollama</div>
        <div class="settings-field">
          <label>Endpoint LM Studio</label>
          <input type="text" id="s-lmstudio" placeholder="http://localhost:1234/v1">
        </div>
        <div class="settings-field">
          <label>Endpoint Ollama</label>
          <input type="text" id="s-ollama" placeholder="http://localhost:11434">
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Agente Cloud</div>
        <div class="settings-field">
          <label>Endpoint del Agente</label>
          <input type="text" id="s-agent" placeholder="https://agent.apliarte.com">
        </div>
        <div class="settings-field">
          <label>API Key del Agente</label>
          <input type="password" id="s-apikey" placeholder="sk-...">
          <div class="settings-hint">Se guarda en configuración global de VS Code</div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Engram MCP</div>
        <div class="settings-field">
          <label>Endpoint Engram HTTP</label>
          <input type="text" id="s-engram" placeholder="http://localhost:4200">
          <div class="settings-hint">Necesita Engram MCP server corriendo localmente</div>
        </div>
      </div>
    </div>
    <div id="settings-footer">
      <button class="settings-btn" id="settings-open-vsc"><i class="codicon codicon-gear"></i> Abrir VS Code Settings</button>
      <button class="settings-btn" id="settings-save"><i class="codicon codicon-save"></i> Guardar</button>
    </div>
  </div>
</div>

<!-- ── Engram panel ────────────────────────────────────────── -->
<div id="engram-overlay">
  <div id="engram-panel">
    <div id="engram-header">
      <h3><i class="codicon codicon-library"></i> Engram — Memoria</h3>
      <div id="engram-header-right">
        <span id="engram-status-dot"></span>
        <span id="engram-status-label">comprobando…</span>
        <button id="engram-close">✕</button>
      </div>
    </div>
    <div id="engram-search-row">
      <input type="text" id="engram-query" placeholder="Buscar en memoria…">
      <button id="engram-search-btn"><i class="codicon codicon-search"></i> Buscar</button>
    </div>
    <div id="engram-results">
      <div id="engram-empty">Buscá algo para ver memorias guardadas</div>
    </div>
    <div id="engram-save-section">
      <details>
        <summary>+ Guardar memoria</summary>
        <div style="margin-top:8px">
          <input type="text" id="engram-save-title" placeholder="Título (ej: 'Decisión de arquitectura')">
          <textarea id="engram-save-content" placeholder="Contenido de la memoria…"></textarea>
          <button id="engram-save-btn"><i class="codicon codicon-save"></i> Guardar en Engram</button>
        </div>
      </details>
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
var engramOverlay   = document.getElementById('engram-overlay');
var engramBtn       = document.getElementById('engram-btn');
var engramClose     = document.getElementById('engram-close');
var engramBadge     = document.getElementById('engram-badge');
var engramDot       = document.getElementById('engram-status-dot');
var engramLabel     = document.getElementById('engram-status-label');
var engramQuery     = document.getElementById('engram-query');
var engramSearchBtn = document.getElementById('engram-search-btn');
var engramResults   = document.getElementById('engram-results');
var engramSaveTitle = document.getElementById('engram-save-title');
var engramSaveCont  = document.getElementById('engram-save-content');
var engramSaveBtn   = document.getElementById('engram-save-btn');
var newConvBtn      = document.getElementById('new-conv-btn');

var streaming   = false;
var curEl       = null;
var rawText     = '';
var codeBlocks  = [];
var activeConvId = null;
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
    convList.innerHTML = '<div id="conv-empty">Sin conversaciones guardadas</div>';
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
          if (confirm('¿Eliminás "' + conv.title + '"? Esta acción no se puede deshacer.')) {
            vscode.postMessage({ type: 'deleteConversation', id: conv.id });
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
      engramEndpoint:   document.getElementById('s-engram').value.trim(),
    }
  });
  settingsOverlay.classList.remove('open');
});
settingsOpenVsc.addEventListener('click', function() {
  vscode.postMessage({ type: 'openVscodeSettings' });
});

/* ── Engram ────────────────────────────────────────────────── */
engramBtn.addEventListener('click', function() {
  engramOverlay.classList.add('open');
  vscode.postMessage({ type: 'checkEngram' });
});
engramClose.addEventListener('click', function() { engramOverlay.classList.remove('open'); });
engramOverlay.addEventListener('click', function(e) {
  if (e.target === engramOverlay) engramOverlay.classList.remove('open');
});

function doEngramSearch() {
  var q = engramQuery.value.trim();
  if (!q) return;
  engramResults.innerHTML = '<div id="engram-empty">Buscando…</div>';
  vscode.postMessage({ type: 'engramSearch', query: q, project: currentProject });
}
engramSearchBtn.addEventListener('click', doEngramSearch);
engramQuery.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doEngramSearch();
});

engramSaveBtn.addEventListener('click', function() {
  var title   = engramSaveTitle.value.trim();
  var content = engramSaveCont.value.trim();
  if (!title || !content) return;
  vscode.postMessage({ type: 'engramSave', title: title, content: content, type: 'discovery', project: currentProject });
  engramSaveTitle.value = '';
  engramSaveCont.value  = '';
});

function renderEngramResults(results) {
  engramResults.innerHTML = '';
  if (!results || results.length === 0) {
    engramResults.innerHTML = '<div id="engram-empty">Sin resultados</div>';
    return;
  }
  results.forEach(function(r) {
    var div = document.createElement('div');
    div.className = 'engram-result';
    div.innerHTML =
      '<div class="engram-result-title">' + esc(r.title || 'Sin título') + '</div>' +
      '<div class="engram-result-content">' + esc((r.content || '').slice(0, 120)) + '</div>' +
      (r.type ? '<div class="engram-result-meta">Tipo: ' + esc(r.type) + (r.score ? ' · Score: ' + r.score.toFixed(2) : '') + '</div>' : '');
    div.title = 'Click para insertar en el chat';
    div.addEventListener('click', function() {
      input.value = r.content || r.title || '';
      input.dispatchEvent(new Event('input'));
      engramOverlay.classList.remove('open');
      input.focus();
    });
    engramResults.appendChild(div);
  });
}

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
function codeBlock(code, lang, isStreaming) {
  var idx = codeBlocks.length;
  codeBlocks.push(code);
  var acts = isStreaming ? '' :
    '<button onclick="cpB(' + idx + ',this)" title="Copiar"><i class="codicon codicon-copy"></i> Copiar</button>' +
    '<button onclick="insB(' + idx + ')" title="Insertar en cursor"><i class="codicon codicon-go-to-file"></i> Insertar</button>' +
    '<button onclick="diffB(' + idx + ')" title="Ver diff y aplicar"><i class="codicon codicon-diff"></i> Aplicar</button>';
  return '<div class="cb' + (isStreaming ? ' streaming' : '') + '">' +
    '<div class="cb-head"><span class="cb-lang">' + (lang || 'code') + '</span><div class="cb-acts">' + acts + '</div></div>' +
    '<pre><code>' + hlCode(code, lang) + '</code></pre>' +
  '</div>';
}

function cpB(idx, btn) {
  navigator.clipboard.writeText(codeBlocks[idx]).then(function() {
    btn.innerHTML = '<i class="codicon codicon-pass"></i> Copiado';
    btn.classList.add('ok');
    setTimeout(function() { btn.innerHTML = '<i class="codicon codicon-copy"></i> Copiar'; btn.classList.remove('ok'); }, 1500);
  });
}
function insB(idx) { vscode.postMessage({ type: 'insertCode', code: codeBlocks[idx] }); }
function diffB(idx) { vscode.postMessage({ type: 'applyDiff', code: codeBlocks[idx] }); }

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
pSel.addEventListener('change', function() { vscode.postMessage({ type: 'setProvider', provider: pSel.value }); });
tempIn.addEventListener('input', function() {
  tempV.textContent = parseFloat(tempIn.value).toFixed(1);
  vscode.postMessage({ type: 'setTemperature', value: parseFloat(tempIn.value) });
});

/* ── Welcome screen contextual ─────────────────────────────── */
var welcomeGuide   = document.getElementById('welcome-guide');
var welcomeDlBtn   = document.getElementById('welcome-dl-btn');
var welcomeSub     = document.getElementById('welcome-sub');

var GUIDE_TEXTS = {
  'local-needs-download': {
    sub: 'Modo local — inferencia en tu máquina, sin internet',
    guide: '⬇️ <strong>Primer paso:</strong> descargá el modelo Qwen 2.5 (0.5B, ~350MB).<br>Solo la primera vez — después carga en segundos.',
    showBtn: true,
  },
  'local-ready': {
    sub: 'Modelo local listo — podés escribir tu primer mensaje',
    guide: '✅ <strong>Todo listo.</strong> El modelo está cargado en memoria. Escribí tu pregunta abajo.',
    showBtn: false,
  },
  'remote-offline': {
    sub: 'LM Studio / Ollama — no detectado',
    guide: '⚠️ <strong>No hay modelo detectado.</strong><br>Opciones:<br>• Abrí <strong>LM Studio</strong> o <strong>Ollama</strong> y cargá un modelo<br>• O cambiá el proveedor a <strong>Local</strong> para inferencia sin instalar nada',
    showBtn: false,
  },
  'remote-ready': {
    sub: 'Conectado — podés escribir tu primer mensaje',
    guide: '',
    showBtn: false,
  },
  'agent': {
    sub: 'Agent Cloud — verificá la conexión en Configuración',
    guide: '☁️ <strong>Modo Agente.</strong> Configurá el endpoint y la API key en <i class="codicon codicon-settings-gear"></i> Configuración.',
    showBtn: false,
  },
};

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
  if (welcomeDlBtn) welcomeDlBtn.style.display = cfg.showBtn ? 'block' : 'none';
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
        document.getElementById('s-preset').value   = d.settings.preset || 'minimal';
        document.getElementById('s-language').value = d.settings.language || 'es';
        document.getElementById('s-lmstudio').value = d.settings.lmstudioEndpoint || '';
        document.getElementById('s-ollama').value   = d.settings.ollamaEndpoint || '';
        document.getElementById('s-agent').value    = d.settings.agentEndpoint || '';
        document.getElementById('s-apikey').value   = d.settings.agentApiKey || '';
        document.getElementById('s-engram').value   = d.settings.engramEndpoint || '';
      }
      break;

    case 'settingsSaved':
      break;

    case 'engramStatus':
      if (d.available) {
        engramDot.classList.add('on'); engramLabel.textContent = 'Conectado';
        engramBadge.classList.add('on');
      } else {
        engramDot.classList.remove('on'); engramLabel.textContent = 'Sin conexión';
        engramBadge.classList.remove('on');
      }
      break;

    case 'engramResults':
      renderEngramResults(d.results);
      break;

    case 'engramSaved':
      break;

    case 'modelsLoaded':
      mSel.innerHTML = '';
      if (d.agentMode) {
        var agOpt = document.createElement('option');
        agOpt.value = 'agent-default'; agOpt.textContent = 'Modelo del servidor'; agOpt.selected = true;
        mSel.appendChild(agOpt); mSel.disabled = true;
        updateWelcomeForProvider('agent');
      } else if (d.localCatalog && d.localCatalog.length > 0) {
        mSel.disabled = false;
        if (d.loadedModel) {
          var lOpt = document.createElement('option');
          lOpt.value = d.loadedModel; lOpt.textContent = d.loadedModel.split('/').pop() + ' (cargado)'; lOpt.selected = true;
          mSel.appendChild(lOpt); mSel.dataset.prev = d.loadedModel;
          updateWelcomeForProvider('local-ready');
        } else {
          updateWelcomeForProvider('local-needs-download');
        }
        var sep = document.createElement('option'); sep.disabled = true; sep.textContent = '── Descargar modelo ──'; mSel.appendChild(sep);
        d.localCatalog.forEach(function(m) {
          if (m.id === d.loadedModel) return;
          var opt = document.createElement('option');
          opt.value = 'download:' + m.id; opt.textContent = m.label + ' (' + m.size + ')' + (m.recommended ? ' ★' : '');
          mSel.appendChild(opt);
        });
        if (!d.loadedModel) {
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
      if (d.status === 'progress' && typeof d.progress === 'number') {
        dlFill.style.width = Math.round(d.progress) + '%';
        dlText.textContent = 'Descargando' + (d.file ? ' ' + d.file.split('/').pop() : '') + '… ' + Math.round(d.progress) + '%';
      } else if (d.status === 'done') { dlFill.style.width = '100%'; }
      break;
    case 'downloadComplete': dlBar.style.display = 'none'; dlFill.style.width = '0%'; break;
    case 'downloadError':    dlBar.style.display = 'none'; dlFill.style.width = '0%'; break;
    case 'modelUnloaded': break;

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
