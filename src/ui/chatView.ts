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

  constructor(private readonly _extensionUri: vscode.Uri) {}

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
        case 'sendMessage':
          await this._handleUserMessage(data.text);
          break;
        case 'clearHistory':
          this._history = [];
          this._post({ type: 'cleared' });
          break;
        case 'stopGeneration':
          this._abortController?.abort();
          break;
        case 'requestModels':
          await this._refreshModels();
          break;
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
        case 'setTemperature':
          this._temperature = data.value;
          break;
        case 'setModel':
          this._currentModel = data.model;
          break;
        case 'setProvider':
          this._provider = data.provider;
          this._currentModel = undefined;
          if (data.provider === 'local') {
            await this._ensureLocalDeps();
          }
          await this._refreshModels();
          await this._sendConnectionStatus();
          break;
        case 'downloadModel':
          await this._downloadLocalModel(data.model);
          break;
        case 'unloadModel':
          await unloadModel();
          this._post({ type: 'modelUnloaded' });
          break;
        case 'exportChat':
          await this._exportChat();
          break;
        case 'checkConnection':
          await this._sendConnectionStatus();
          break;
      }
    });

    this._refreshModels();
    this._sendConnectionStatus();
  }

  public attachContext(name: string, text: string): void {
    this._contextText = text;
    this._contextName = name;
    this._post({ type: 'contextAttached', name, preview: text.slice(0, 200) });
  }

  public sendMessage(text: string): void {
    this._post({ type: 'autoSend', text });
  }

  private async _handleUserMessage(text: string): Promise<void> {
    if (!this._view) return;

    const config = vscode.workspace.getConfiguration('apliarteAi');

    if (!this._currentModel && this._provider !== 'agent') {
      await this._refreshModels();
    }
    if (!this._currentModel && this._provider !== 'agent') {
      const hint = this._provider === 'local'
        ? 'No hay modelo local cargado. Descarga uno desde el selector.'
        : 'No hay modelo cargado. Abre LM Studio, carga un modelo, y vuelve a intentar.';
      this._post({ type: 'responseError', text: hint });
      return;
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
        const endpoint = config.get<string>('lmstudioEndpoint', 'http://localhost:1234/v1');
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
      this._post({ type: 'responseEnd' });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this._post({ type: 'responseStopped' });
        return;
      }
      const msg = error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Chat error: ${msg}`);
      this._post({ type: 'responseError', text: msg });
      // Remove last user message from history so they can retry
      this._history.pop();
    } finally {
      this._abortController = undefined;
    }
  }

  /**
   * Agent chat with tool-calling loop.
   * The agent backend may request tools → we execute locally → send results back.
   * Max 10 tool iterations to prevent infinite loops.
   */
  private async _handleAgentChat(
    config: vscode.WorkspaceConfiguration,
    messages: ChatMessage[]
  ): Promise<string> {
    const endpoint = config.get<string>('agentEndpoint', '');
    const apiKey = config.get<string>('agentApiKey', '');

    if (!endpoint) throw new Error('Configura apliarteAi.agentEndpoint en Settings.');
    if (!apiKey) throw new Error('Configura apliarteAi.agentApiKey en Settings.');

    // Get workspace ID for RAG
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
            // Show tool call in UI
            this._post({
              type: 'responseChunk',
              text: `\n\n**Ejecutando ${tc.name}**...\n`,
            });
            fullResponse += `\n\n**Ejecutando ${tc.name}**...\n`;

            // Execute tool locally
            const result = await executeTool(tc);

            // Append assistant tool_call + tool result to messages (OpenAI format)
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
              role: 'tool' as 'user', // ChatMessage type doesn't have 'tool', cast for protocol
              content: result.content,
              // @ts-expect-error — tool_call_id field for OpenAI protocol
              tool_call_id: tc.id,
            });

            // Show tool result preview
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

      // If no tool call, we're done
      if (!gotToolCall) break;
    }

    return fullResponse;
  }

  private async _refreshModels(): Promise<void> {
    if (this._provider === 'agent') {
      // Agent mode doesn't use local model selector — model is picked server-side
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

    const config = vscode.workspace.getConfiguration('apliarteAi');
    const endpoint = config.get<string>('lmstudioEndpoint', 'http://localhost:1234/v1');

    // Try up to 2 times with a small delay
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
      const apiKey = config.get<string>('agentApiKey', '');
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
    const config = vscode.workspace.getConfiguration('apliarteAi');
    const endpoint = config.get<string>('lmstudioEndpoint', 'http://localhost:1234/v1');
    const connected = await checkConnection(endpoint);
    this._post({ type: 'connectionStatus', connected, provider: 'remote' });
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
      // Revert to remote provider
      this._provider = 'remote';
    }
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
      vscode.window.showWarningMessage('No hay editor activo. Abre el archivo donde quieres aplicar el cambio.');
      return;
    }

    const originalUri = editor.document.uri;
    const originalContent = editor.document.getText();
    const fileName = editor.document.fileName.split('/').pop() ?? 'archivo';

    const proposedDoc = await vscode.workspace.openTextDocument({
      content: code,
      language: editor.document.languageId,
    });

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedDoc.uri,
      `${fileName} ↔ Propuesta ApliArte AI`
    );

    const action = await vscode.window.showInformationMessage(
      '¿Quieres aplicar estos cambios?',
      'Aplicar',
      'Cancelar'
    );

    if (action === 'Aplicar') {
      const edit = new vscode.WorkspaceEdit();
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

  private async _exportChat(): Promise<void> {
    if (this._history.length === 0) return;
    let md = '# ApliArte AI Chat Export\n\n';
    for (const msg of this._history) {
      const label = msg.role === 'user' ? '**Tú**' : '**ApliArte AI**';
      md += `${label}:\n\n${msg.content}\n\n---\n\n`;
    }
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc);
  }

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
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size);
  color:var(--vscode-foreground);
  background:var(--vscode-sideBar-background);
  display:flex;flex-direction:column;height:100vh;overflow:hidden;
}

/* ── Toolbar ───────────────────────────────────────────── */
#toolbar{
  display:flex;align-items:center;padding:6px 10px;gap:6px;
  border-bottom:1px solid var(--vscode-panel-border);
  background:var(--vscode-sideBar-background);
  position:sticky;top:0;z-index:10;
}
#status{display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap;}
.dot{width:7px;height:7px;border-radius:50%;background:#ef4444;flex-shrink:0;}
.dot.on{background:#22c55e;box-shadow:0 0 6px #22c55e80;animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
#model-select{
  flex:1;max-width:180px;
  background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border);border-radius:4px;
  padding:2px 4px;font-size:11px;
}
#provider-select{
  max-width:140px;
  background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border);border-radius:4px;
  padding:2px 4px;font-size:11px;
}
.tb{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;
  font-size:14px;opacity:.55;padding:2px 4px;border-radius:3px;}
.tb:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground);}

/* ── Messages ──────────────────────────────────────────── */
#messages{flex:1;overflow-y:auto;scroll-behavior:smooth;}

/* ── Welcome ───────────────────────────────────────────── */
#welcome{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:32px 16px;text-align:center;animation:fadeUp .5s ease;
}
#welcome .logo{font-size:44px;margin-bottom:8px;}
#welcome h2{font-size:16px;font-weight:700;margin-bottom:4px;}
#welcome .sub{font-size:11px;opacity:.5;margin-bottom:18px;}
.qa{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;}
.qa button{
  background:var(--vscode-button-secondaryBackground);
  color:var(--vscode-button-secondaryForeground);
  border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:11px;
  transition:all .2s;
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
.msg-body blockquote{border-left:3px solid var(--vscode-textBlockQuote-border);
  padding:3px 10px;margin:4px 0;opacity:.8;}
.msg-body .li{padding-left:14px;position:relative;}
.msg-body .li::before{content:'';position:absolute;left:4px;top:8px;
  width:4px;height:4px;border-radius:50%;background:var(--vscode-foreground);opacity:.45;}
.msg-body hr{border:none;border-top:1px solid var(--vscode-panel-border);margin:8px 0;}

/* ── Inline code ───────────────────────────────────────── */
code.il{background:var(--vscode-textCodeBlock-background);padding:1px 5px;
  border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:12px;}

/* ── Code block ────────────────────────────────────────── */
.cb{margin:8px 0;border-radius:6px;overflow:hidden;
  border:1px solid var(--vscode-panel-border);}
.cb-head{display:flex;align-items:center;justify-content:space-between;
  padding:3px 10px;font-size:10px;
  background:color-mix(in srgb,var(--vscode-sideBar-background),#000 12%);}
.cb-lang{opacity:.55;font-family:var(--vscode-editor-font-family);}
.cb-acts{display:flex;gap:2px;}
.cb-acts button{background:none;border:none;color:var(--vscode-foreground);
  cursor:pointer;font-size:10px;opacity:.5;padding:2px 6px;border-radius:3px;
  transition:all .15s;}
.cb-acts button:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground);}
.cb-acts button.ok{color:var(--vscode-terminal-ansiGreen);opacity:1;}
.cb pre{margin:0;padding:10px 12px;overflow-x:auto;
  background:var(--vscode-textCodeBlock-background);
  font-family:var(--vscode-editor-font-family);font-size:12px;line-height:1.5;
  tab-size:2;}

/* ── Syntax colors ─────────────────────────────────────── */
.hl-kw{color:#c586c0;} .hl-str{color:#ce9178;} .hl-cm{color:#6a9955;opacity:.85;}
.hl-nm{color:#b5cea8;} .hl-tp{color:#4ec9b0;} .hl-fn{color:#dcdcaa;}

/* ── Streaming cursor ──────────────────────────────────── */
.cursor{display:inline-block;width:2px;height:13px;
  background:var(--vscode-terminal-ansiGreen);
  animation:blink .7s step-end infinite;vertical-align:text-bottom;margin-left:1px;}
@keyframes blink{50%{opacity:0}}

/* ── Thinking dots ─────────────────────────────────────── */
.thinking{display:flex;align-items:center;gap:3px;opacity:.55;font-style:italic;font-size:12px;}
.thinking .d{animation:dp 1.4s infinite;display:inline-block;}
.thinking .d:nth-child(2){animation-delay:.2s;}
.thinking .d:nth-child(3){animation-delay:.4s;}
@keyframes dp{0%,80%,100%{opacity:.2}40%{opacity:1}}

/* ── Context bar ───────────────────────────────────────── */
#ctx{display:none;padding:4px 10px;font-size:11px;align-items:center;gap:6px;
  background:var(--vscode-editorWidget-background);
  border-bottom:1px solid var(--vscode-panel-border);}
#ctx.on{display:flex;}
#ctx .info{flex:1;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#ctx .rm{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;
  opacity:.45;font-size:12px;}
#ctx .rm:hover{opacity:1;}

/* ── Input area ────────────────────────────────────────── */
#input-area{border-top:1px solid var(--vscode-panel-border);}
#input-row{display:flex;padding:8px 10px;gap:6px;align-items:flex-end;}
#input-row textarea{
  flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border);border-radius:8px;
  padding:8px 12px;font-family:var(--vscode-font-family);font-size:13px;
  resize:none;min-height:38px;max-height:150px;line-height:1.4;transition:border-color .2s;
}
#input-row textarea:focus{outline:none;border-color:var(--vscode-focusBorder);}
.act-btn{width:34px;height:34px;border:none;border-radius:8px;cursor:pointer;
  font-size:15px;display:flex;align-items:center;justify-content:center;transition:all .15s;}
#send-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}
#send-btn:hover{filter:brightness(1.15);}
#send-btn:disabled{opacity:.35;cursor:not-allowed;}
#stop-btn{background:var(--vscode-errorForeground);color:#fff;display:none;}
#stop-btn:hover{opacity:.8;}

/* ── Footer stats ──────────────────────────────────────── */
#stats{display:flex;justify-content:space-between;align-items:center;
  padding:2px 12px 6px;font-size:10px;opacity:.45;}
.temp-ctrl{display:flex;align-items:center;gap:4px;cursor:default;}
.temp-ctrl input[type=range]{
  width:55px;height:3px;-webkit-appearance:none;appearance:none;
  background:var(--vscode-scrollbarSlider-background);border-radius:2px;outline:none;
  cursor:pointer;
}
.temp-ctrl input[type=range]::-webkit-slider-thumb{
  -webkit-appearance:none;width:10px;height:10px;border-radius:50%;
  background:var(--vscode-button-background);cursor:pointer;
}
/* ── Codicon ───────────────────────────────────────────── */
.codicon{font-size:inherit;vertical-align:middle;}
.msg-hdr .codicon{font-size:12px;}
.tb .codicon{font-size:14px;}
.act-btn .codicon{font-size:15px;}
.cb-acts .codicon{font-size:10px;}
.qa .codicon{font-size:13px;margin-right:2px;}
#welcome .logo .codicon{font-size:44px;}
</style>
</head>
<body>

<!-- ── Toolbar ──────────────────────────────────────────── -->
<div id="toolbar">
  <div id="status"><span class="dot" id="dot"></span><span id="st-text">…</span></div>
  <select id="provider-select" title="Proveedor">
    <option value="remote">LM Studio / Ollama</option>
    <option value="local">Local (sin instalar nada)</option>
    <option value="agent">Agent (Cloud)</option>
  </select>
  <select id="model-select" title="Modelo"><option value="">cargando…</option></select>
  <button class="tb" id="export-btn" title="Exportar chat"><i class="codicon codicon-export"></i></button>
  <button class="tb" id="clear-btn" title="Limpiar chat"><i class="codicon codicon-trash"></i></button>
</div>

<!-- ── Download progress bar ───────────────────────────── -->
<div id="download-bar" style="display:none;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);">
  <div style="font-size:11px;margin-bottom:4px;" id="dl-text">Descargando modelo…</div>
  <div style="width:100%;height:4px;background:var(--vscode-input-background);border-radius:2px;overflow:hidden;">
    <div id="dl-fill" style="width:0%;height:100%;background:var(--vscode-button-background);transition:width 0.3s;"></div>
  </div>
</div>

<!-- ── Messages ────────────────────────────────────────── -->
<div id="messages">
  <div id="welcome">
    <div class="logo"><i class="codicon codicon-hubot"></i></div>
    <h2>ApliArte AI Chat</h2>
    <p class="sub">100% local · 0 coste · Tus datos, tu máquina</p>
    <p class="sub" style="font-size:11px;margin-top:4px;">Modo Local: no necesitas instalar nada extra</p>
    <div class="qa">
      <button onclick="reqCtx('file')"><i class="codicon codicon-file"></i> Enviar archivo</button>
      <button onclick="reqCtx('selection')"><i class="codicon codicon-code"></i> Enviar selección</button>
    </div>
  </div>
</div>

<!-- ── Context bar ─────────────────────────────────────── -->
<div id="ctx">
  <span><i class="codicon codicon-pin"></i></span><span class="info" id="ctx-info"></span>
  <button class="rm" id="ctx-rm" title="Quitar contexto">✕</button>
</div>

<!-- ── Input area ──────────────────────────────────────── -->
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

<script>
/* ================================================================
   ApliArte AI Chat — Webview JS
   ================================================================ */
var vscode = acquireVsCodeApi();
var msgs   = document.getElementById('messages');
var input  = document.getElementById('input');
var sendB  = document.getElementById('send-btn');
var stopB  = document.getElementById('stop-btn');
var clearB = document.getElementById('clear-btn');
var expB   = document.getElementById('export-btn');
var attB   = document.getElementById('attach-btn');
var dot    = document.getElementById('dot');
var stTxt  = document.getElementById('st-text');
var mSel   = document.getElementById('model-select');
var pSel   = document.getElementById('provider-select');
var dlBar  = document.getElementById('download-bar');
var dlText = document.getElementById('dl-text');
var dlFill = document.getElementById('dl-fill');
var ctxBar = document.getElementById('ctx');
var ctxI   = document.getElementById('ctx-info');
var ctxRm  = document.getElementById('ctx-rm');
var wcEl   = document.getElementById('wc');
var tempIn = document.getElementById('temp');
var tempV  = document.getElementById('temp-val');
var welc   = document.getElementById('welcome');

var streaming   = false;
var curEl       = null;
var rawText     = '';
var codeBlocks  = [];

/* ── Markdown renderer ─────────────────────────────────── */
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
      inCode = true;
      codeLang = ln.substring(3).trim();
      codeBuf = '';
      continue;
    }
    if (inCode && ln.substring(0,3) === '\`\`\`') {
      inCode = false;
      html += codeBlock(codeBuf, codeLang, false);
      continue;
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

/* ── Code blocks ───────────────────────────────────────── */
function codeBlock(code, lang, isStreaming) {
  var idx = codeBlocks.length;
  codeBlocks.push(code);
  var acts = isStreaming ? '' :
    '<button onclick="cpB(' + idx + ',this)" title="Copiar"><i class="codicon codicon-copy"></i> Copiar</button>' +
    '<button onclick="insB(' + idx + ')" title="Insertar en cursor"><i class="codicon codicon-go-to-file"></i> Insertar</button>' +
    '<button onclick="diffB(' + idx + ')" title="Ver diff y aplicar"><i class="codicon codicon-diff"></i> Aplicar</button>';
  return '<div class="cb' + (isStreaming ? ' streaming' : '') + '">' +
    '<div class="cb-head">' +
      '<span class="cb-lang">' + (lang || 'code') + '</span>' +
      '<div class="cb-acts">' + acts + '</div>' +
    '</div>' +
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

function insB(idx) {
  vscode.postMessage({ type: 'insertCode', code: codeBlocks[idx] });
}

function diffB(idx) {
  vscode.postMessage({ type: 'applyDiff', code: codeBlocks[idx] });
}

/* ── Syntax highlighting (lightweight) ─────────────────── */
function hlCode(code, lang) {
  code = esc(code);
  var kwMap = {
    'javascript':'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|import|export|from|default|async|await|try|catch|throw|finally|new|typeof|instanceof|of|in|this|super|extends|yield|static|get|set|null|undefined|true|false|void',
    'typescript':'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|import|export|from|default|async|await|try|catch|throw|finally|new|typeof|instanceof|of|in|this|super|extends|yield|static|get|set|null|undefined|true|false|void|interface|type|enum|declare|namespace|abstract|readonly|keyof|infer|as|is|string|number|boolean|any|never|unknown',
    'python':'def|class|import|from|return|if|elif|else|for|while|try|except|finally|raise|with|as|lambda|yield|pass|break|continue|and|or|not|is|in|True|False|None|self|print|async|await',
    'go':'func|return|if|else|for|range|switch|case|default|break|continue|var|const|type|struct|interface|map|chan|go|defer|select|package|import|nil|true|false|error|string|int|bool',
    'html':'html|head|body|div|span|p|a|ul|ol|li|h1|h2|h3|h4|h5|h6|img|input|button|form|table|tr|td|th|script|style|link|meta|section|nav|header|footer|main|article|aside',
    'css':'color|background|margin|padding|border|display|flex|grid|position|width|height|font|text|align|justify|content|items|gap|overflow|opacity|transition|animation|transform|z-index|top|left|right|bottom'
  };
  var alias = { 'js':'javascript','ts':'typescript','tsx':'typescript','jsx':'javascript','py':'python','golang':'go' };
  var eLang = alias[lang] || lang || 'javascript';
  var kw = kwMap[eLang] || kwMap['javascript'];

  var result = code.split('\\n').map(function(line) {
    var commentIdx = -1;
    if (eLang === 'python') { commentIdx = line.indexOf('#'); }
    else { commentIdx = line.indexOf('//'); }

    var main = commentIdx >= 0 ? line.substring(0, commentIdx) : line;
    var cmPart = commentIdx >= 0 ? '<span class="hl-cm">' + line.substring(commentIdx) + '</span>' : '';

    if (kw) {
      main = main.replace(new RegExp('\\\\b(' + kw + ')\\\\b', 'g'), '<span class="hl-kw">$1</span>');
    }
    main = main.replace(/\\b(\\d+\\.?\\d*)\\b/g, '<span class="hl-nm">$1</span>');
    main = main.replace(/\\b([A-Z][a-zA-Z0-9]+)\\b/g, '<span class="hl-tp">$1</span>');
    return main + cmPart;
  }).join('\\n');

  return result;
}

/* ── UI helpers ────────────────────────────────────────── */
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

/* ── Send ──────────────────────────────────────────────── */
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

/* ── Stop ──────────────────────────────────────────────── */
stopB.addEventListener('click', function() {
  vscode.postMessage({ type: 'stopGeneration' });
});

/* ── Clear ─────────────────────────────────────────────── */
clearB.addEventListener('click', function() {
  msgs.innerHTML = '';
  if (welc) { welc.style.display = ''; msgs.appendChild(welc); }
  vscode.postMessage({ type: 'clearHistory' });
});

/* ── Export ─────────────────────────────────────────────── */
expB.addEventListener('click', function() { vscode.postMessage({ type: 'exportChat' }); });

/* ── Attach ────────────────────────────────────────────── */
attB.addEventListener('click', function() { reqCtx('file'); });
function reqCtx(scope) { vscode.postMessage({ type: 'requestContext', scope: scope }); }

ctxRm.addEventListener('click', function() {
  ctxBar.classList.remove('on');
  vscode.postMessage({ type: 'removeContext' });
});

/* ── Model selector ────────────────────────────────────── */
mSel.addEventListener('change', function() {
  var val = mSel.value;
  if (val.startsWith('download:')) {
    var modelId = val.substring(9);
    vscode.postMessage({ type: 'downloadModel', model: modelId });
    // Reset selector to previous
    if (mSel.dataset.prev) mSel.value = mSel.dataset.prev;
  } else {
    mSel.dataset.prev = val;
    vscode.postMessage({ type: 'setModel', model: val });
  }
});
vscode.postMessage({ type: 'requestModels' });

/* ── Provider selector ─────────────────────────────────── */
pSel.addEventListener('change', function() {
  vscode.postMessage({ type: 'setProvider', provider: pSel.value });
});

/* ── Temperature ───────────────────────────────────────── */
tempIn.addEventListener('input', function() {
  tempV.textContent = parseFloat(tempIn.value).toFixed(1);
  vscode.postMessage({ type: 'setTemperature', value: parseFloat(tempIn.value) });
});

/* ── Connection check (periodic) ───────────────────────── */
vscode.postMessage({ type: 'checkConnection' });
setInterval(function() { vscode.postMessage({ type: 'checkConnection' }); }, 15000);

/* ── Messages from extension ───────────────────────────── */
window.addEventListener('message', function(event) {
  var d = event.data;
  switch (d.type) {

    case 'responseStart':
      streaming = true;
      sendB.style.display = 'none';
      stopB.style.display = 'flex';
      rawText = '';
      hideWelcome();
      curEl = document.createElement('div');
      curEl.className = 'msg assistant';
      curEl.innerHTML = '<div class="msg-hdr"><span><i class="codicon codicon-hubot"></i></span> ApliArte AI</div>' +
        '<div class="msg-body"><span class="thinking">Pensando<span class="d">.</span><span class="d">.</span><span class="d">.</span></span></div>';
      msgs.appendChild(curEl);
      msgs.scrollTop = msgs.scrollHeight;
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
      streaming = false;
      sendB.style.display = 'flex';
      stopB.style.display = 'none';
      if (curEl) {
        var body = curEl.querySelector('.msg-body');
        body.innerHTML = renderMD(rawText);
      }
      curEl = null;
      rawText = '';
      input.focus();
      break;

    case 'responseStopped':
      streaming = false;
      sendB.style.display = 'flex';
      stopB.style.display = 'none';
      if (curEl) {
        var body = curEl.querySelector('.msg-body');
        body.innerHTML = renderMD(rawText) + '<div style="margin-top:6px;font-size:11px;opacity:.5;font-style:italic;"><i class="codicon codicon-debug-stop"></i> Generación detenida</div>';
      }
      curEl = null;
      rawText = '';
      input.focus();
      break;

    case 'responseError':
      streaming = false;
      sendB.style.display = 'flex';
      stopB.style.display = 'none';
      if (curEl) {
        var body = curEl.querySelector('.msg-body');
        body.innerHTML = '<div style="color:var(--vscode-errorForeground)"><i class="codicon codicon-warning"></i> ' + esc(d.text) + '</div>' +
          '<div style="margin-top:4px;font-size:11px;opacity:.55;">Verifica que LM Studio esté corriendo y tenga un modelo cargado.</div>';
      } else {
        // No assistant element yet — show error as a message
        hideWelcome();
        var errDiv = document.createElement('div');
        errDiv.className = 'msg assistant';
        errDiv.innerHTML = '<div class="msg-hdr"><span><i class="codicon codicon-warning"></i></span> Error</div>' +
          '<div class="msg-body"><div style="color:var(--vscode-errorForeground)">' + esc(d.text) + '</div>' +
          '<div style="margin-top:4px;font-size:11px;opacity:.55;">Verifica que LM Studio esté corriendo y tenga un modelo cargado.</div></div>';
        msgs.appendChild(errDiv);
        msgs.scrollTop = msgs.scrollHeight;
      }
      curEl = null;
      rawText = '';
      input.focus();
      break;

    case 'cleared':
      break;

    case 'modelsLoaded':
      mSel.innerHTML = '';
      if (d.agentMode) {
        // Agent provider — model selector hidden, agent picks server-side
        var agOpt = document.createElement('option');
        agOpt.value = 'agent-default';
        agOpt.textContent = 'Modelo del servidor';
        agOpt.selected = true;
        mSel.appendChild(agOpt);
        mSel.disabled = true;
      } else if (d.localCatalog && d.localCatalog.length > 0) {
        mSel.disabled = false;
        // Local provider — show catalog with download options
        if (d.loadedModel) {
          var lOpt = document.createElement('option');
          lOpt.value = d.loadedModel;
          lOpt.textContent = d.loadedModel.split('/').pop() + ' (cargado)';
          lOpt.selected = true;
          mSel.appendChild(lOpt);
          mSel.dataset.prev = d.loadedModel;
        }
        var sep = document.createElement('option');
        sep.disabled = true;
        sep.textContent = '── Descargar modelo ──';
        mSel.appendChild(sep);
        d.localCatalog.forEach(function(m) {
          if (m.id === d.loadedModel) return;
          var opt = document.createElement('option');
          opt.value = 'download:' + m.id;
          opt.textContent = m.label + ' (' + m.size + ')' + (m.recommended ? ' ★' : '');
          mSel.appendChild(opt);
        });
        if (!d.loadedModel) {
          var hint = document.createElement('option');
          hint.value = '';
          hint.textContent = 'Selecciona un modelo para descargar';
          hint.selected = true;
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
      } else {
        var opt = document.createElement('option');
        opt.value = ''; opt.textContent = 'Sin modelos — abre LM Studio';
        mSel.appendChild(opt);
      }
      break;

    case 'connectionStatus':
      if (d.provider === 'agent') {
        if (d.connected) {
          dot.classList.add('on');
          stTxt.textContent = 'Agent';
        } else {
          dot.classList.remove('on');
          stTxt.textContent = 'Agent offline';
        }
      } else if (d.provider === 'local') {
        if (d.connected) {
          dot.classList.add('on');
          stTxt.textContent = 'Local';
        } else {
          dot.classList.remove('on');
          stTxt.textContent = 'Sin modelo';
        }
      } else {
        if (d.connected) {
          dot.classList.add('on');
          stTxt.textContent = 'Online';
        } else {
          dot.classList.remove('on');
          stTxt.textContent = 'Offline';
        }
      }
      break;

    case 'downloadStart':
      dlBar.style.display = 'block';
      dlText.textContent = 'Descargando ' + (d.model ? d.model.split('/').pop() : 'modelo') + '…';
      dlFill.style.width = '0%';
      break;

    case 'downloadProgress':
      if (d.status === 'progress' && typeof d.progress === 'number') {
        dlFill.style.width = Math.round(d.progress) + '%';
        dlText.textContent = 'Descargando' + (d.file ? ' ' + d.file.split('/').pop() : '') + '… ' + Math.round(d.progress) + '%';
      } else if (d.status === 'done') {
        dlFill.style.width = '100%';
      }
      break;

    case 'downloadComplete':
      dlBar.style.display = 'none';
      dlFill.style.width = '0%';
      break;

    case 'downloadError':
      dlBar.style.display = 'none';
      dlFill.style.width = '0%';
      break;

    case 'modelUnloaded':
      break;

    case 'contextAttached':
      ctxBar.classList.add('on');
      ctxI.innerHTML = '<i class="codicon codicon-pin"></i> ' + d.name + (d.preview ? ' — ' + d.preview.substring(0, 60) + '…' : '');
      break;

    case 'contextRemoved':
      ctxBar.classList.remove('on');
      break;

    case 'contextError':
      ctxBar.classList.remove('on');
      break;

    case 'autoSend':
      input.value = d.text;
      send();
      break;
  }
});

input.focus();
</script>
</body>
</html>`;
  }
}
