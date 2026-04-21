/* ================================================================
   ApliArte AI Chat — Webview JS
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
    welcome_folder_hint: 'Apunta a donde tienes tus modelos descargados (disco externo, tarjeta SD, etc.)',
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
    s_models_dir_desc: 'Elige dónde guardas tus modelos de IA. Puede ser un disco externo, una tarjeta SD o cualquier carpeta. Los buscará ahí automáticamente.',
    s_models_dir_none: 'Sin carpeta configurada (usa almacenamiento por defecto)',
    s_choose_dir_big: 'Cambiar carpeta de modelos',
    s_move_models_info: '¿Tienes modelos en otro lugar? Da este prompt al Agente para que los mueva:',
    s_copy: 'Copiar',
    s_agent_title: '🤖 Agente Remoto',
    s_agent_endpoint: 'URL del servidor',
    s_agent_ph: 'https://mi-servidor.com',
    agent_info_1: 'Necesitas tu propio servidor para usar el modo Agente. Es el backend que habla con el LLM en la nube por ti.',
    agent_info_2: 'La forma más fácil es desplegarlo en Hostinger (VPS desde €4/mes):',
    agent_hostinger: 'Abrir Hostinger (descuento incluido)',
    agent_info_3: 'O sigue la guía del repositorio para instalar el backend en cualquier servidor.',
    s_apikey: 'API Key',
    s_apikey_hint: 'Se guarda en configuración global de VS Code',
    s_mcp_local_title: '🔌 Agregar herramienta MCP local',
    s_mcp_local_desc: 'Conecta servidores MCP que corren en tu máquina — sin internet, 100% privado.',
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
    GUIDE_TEXTS['local-needs-folder'].sub = 'Modo local — primero configura tu carpeta de modelos';
    GUIDE_TEXTS['local-needs-folder'].guide = '📁 <strong>¿Dónde están tus modelos?</strong><br>Elige la carpeta donde están tus modelos descargados (disco externo, tarjeta SD, o cualquier carpeta local). La extensión los buscará ahí automáticamente.';
    GUIDE_TEXTS['local-needs-download'].sub = 'Modo local — inferencia en tu máquina, sin internet';
    GUIDE_TEXTS['local-needs-download'].guide = '⬇️ <strong>Primer paso:</strong> descarga el modelo Qwen 2.5 (0.5B, ~350MB).<br>Solo la primera vez — después carga en segundos.';
    GUIDE_TEXTS['local-ready'].sub = 'Modelo local listo — puedes escribir tu primer mensaje';
    GUIDE_TEXTS['local-ready'].guide = '✅ <strong>Todo listo.</strong> El modelo está cargado en memoria. Escribe tu pregunta abajo.';
    GUIDE_TEXTS['remote-offline'].sub = 'LM Studio / Ollama — no detectado';
    GUIDE_TEXTS['remote-offline'].guide = '⚠️ <strong>No hay modelo detectado.</strong><br>Opciones:<br>• Abre <strong>LM Studio</strong> o <strong>Ollama</strong> y carga un modelo<br>• O cambia el proveedor a <strong>Local</strong> para inferencia sin instalar nada';
    GUIDE_TEXTS['remote-ready'].sub = 'Conectado — puedes escribir tu primer mensaje';
    GUIDE_TEXTS['agent'].sub = 'Agent Cloud — verifica la conexión en Configuración';
    GUIDE_TEXTS['agent'].guide = '☁️ <strong>Modo Agente.</strong> Configura el endpoint y la API key en <i class="codicon codicon-settings-gear"></i> Configuración.';
  }
}

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
      prompt.value = 'Mueve todos mis modelos de IA a la carpeta: ' + dir + '\n' +
        'Busca modelos en las subcarpetas actuales (formatos: .onnx, .safetensors, .gguf, carpetas con config.json) y cópialos o muévelos ahí. Si ya están en esa carpeta, no hagas nada.';
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
var MCP_PRESETS = {
  memory: { name: 'memory', config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } },
  github: { name: 'github', config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' } } },
  postgres: { name: 'postgres', config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], env: { POSTGRES_CONNECTION_STRING: 'postgresql://user:pass@localhost/db' } } },
  sqlite: { name: 'sqlite', config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', './db.sqlite'] } },
  playwright: { name: 'playwright', config: { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'] } },
};

var MCP_STACKS = {
  node:      ['memory', 'filesystem', 'github'],
  python:    ['memory', 'filesystem', 'postgres'],
  go:        ['memory', 'filesystem', 'github'],
  fullstack: ['memory', 'filesystem', 'github', 'playwright'],
};

function addMcpPreset(type) {
  if (type === 'filesystem') {
    vscode.postMessage({ type: 'chooseMcpFolder' });
    return;
  }
  var preset = MCP_PRESETS[type];
  if (preset) {
    vscode.postMessage({ type: 'addMcpServer', name: preset.name, config: preset.config });
  }
}

function applyMcpStack(stack) {
  var servers = MCP_STACKS[stack];
  if (!servers) return;
  servers.forEach(function(s) {
    if (s === 'filesystem') {
      vscode.postMessage({ type: 'chooseMcpFolder' });
    } else {
      var preset = MCP_PRESETS[s];
      if (preset) vscode.postMessage({ type: 'addMcpServer', name: preset.name, config: preset.config });
    }
  });
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

/* ── Folder button visibility ───────────────────────────────── */
var folderBtn = document.getElementById('folder-btn');
function updateFolderBtnVisibility(provider) {
  if (folderBtn) folderBtn.style.display = provider === 'local' ? 'flex' : 'none';
}

/* ── Inference stats / slow-model banner ───────────────────── */
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
    hfResultsEl.innerHTML = '<div style="padding:16px;text-align:center;font-size:12px;opacity:.5;font-style:italic;">Sin resultados. Prueba con otro término.</div>';
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
    if (rawText) {
      var mdDiv = document.createElement('div');
      mdDiv.innerHTML = renderMD(rawText);
      body.appendChild(mdDiv);
      rawText = '';
      body.querySelector('.cursor') && body.querySelector('.cursor').remove();
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
  var lines = text.split('\n');
  var html = '';
  var inCode = false;
  var codeBuf = '';
  var codeLang = '';
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (!inCode && ln.substring(0,3) === '```') {
      inCode = true; codeLang = ln.substring(3).trim(); codeBuf = ''; continue;
    }
    if (inCode && ln.substring(0,3) === '```') {
      inCode = false; html += codeBlock(codeBuf, codeLang, false); continue;
    }
    if (inCode) { codeBuf += (codeBuf ? '\n' : '') + ln; continue; }
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
  var olM = ln.match(/^(\d+)\. (.+)/);
  if (olM) return '<div class="li">' + olM[1] + '. ' + inl(olM[2]) + '</div>';
  return '<div class="line">' + inl(ln) + '</div>';
}

function inl(t) {
  t = esc(t);
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
  t = t.replace(/~~(.+?)~~/g, '<del>$1</del>');
  t = t.replace(/`([^`]+)`/g, '<code class="il">$1</code>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" title="$2">$1</a>');
  return t;
}

function esc(t) {
  var d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

/* ── Code blocks ───────────────────────────────────────────── */
var codeBlockAlts = {};
var codeBlockTab  = {};

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
  var result = code.split('\n').map(function(line) {
    var commentIdx = eLang === 'python' ? line.indexOf('#') : line.indexOf('//');
    var main = commentIdx >= 0 ? line.substring(0, commentIdx) : line;
    var cmPart = commentIdx >= 0 ? '<span class="hl-cm">' + line.substring(commentIdx) + '</span>' : '';
    if (kw) main = main.replace(new RegExp('\\b(' + kw + ')\\b', 'g'), '<span class="hl-kw">$1</span>');
    main = main.replace(/\b(\d+\.?\d*)\b/g, '<span class="hl-nm">$1</span>');
    main = main.replace(/\b([A-Z][a-zA-Z0-9]+)\b/g, '<span class="hl-tp">$1</span>');
    return main + cmPart;
  }).join('\n');
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
  var w = input.value.trim().split(/\s+/).filter(function(x){return x;}).length;
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
  } else if (val.startsWith('gguf:')) {
    var ggufPath = val.substring(5);
    vscode.postMessage({ type: 'loadGgufModel', path: ggufPath });
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
    sub: 'Modo local — primero configura tu carpeta de modelos',
    guide: '📁 <strong>¿Dónde están tus modelos?</strong><br>Elige la carpeta donde están tus modelos descargados (disco externo, tarjeta SD, o cualquier carpeta local). La extensión los buscará ahí automáticamente.',
    showBtn: false,
    showFolderBtn: true,
  },
  'local-needs-download': {
    sub: 'Modo local — inferencia en tu máquina, sin internet',
    guide: '⬇️ <strong>Primer paso:</strong> descarga el modelo Qwen 2.5 (0.5B, ~350MB).<br>Solo la primera vez — después carga en segundos.',
    showBtn: true,
    showFolderBtn: false,
  },
  'local-ready': {
    sub: 'Modelo local listo — puedes escribir tu primer mensaje',
    guide: '✅ <strong>Todo listo.</strong> El modelo está cargado en memoria. Escribe tu pregunta abajo.',
    showBtn: false, showFolderBtn: false,
  },
  'remote-offline': {
    sub: 'LM Studio / Ollama — no detectado',
    guide: '⚠️ <strong>No hay modelo detectado.</strong><br>Opciones:<br>• Abre <strong>LM Studio</strong> o <strong>Ollama</strong> y carga un modelo<br>• O cambia el proveedor a <strong>Local</strong> para inferencia sin instalar nada',
    showBtn: false, showFolderBtn: false,
  },
  'remote-ready': {
    sub: 'Conectado — puedes escribir tu primer mensaje',
    guide: '', showBtn: false, showFolderBtn: false,
  },
  'agent': {
    sub: 'Agent Cloud — verifica la conexión en Configuración',
    guide: '☁️ <strong>Modo Agente.</strong> Configura el endpoint y la API key en <i class="codicon codicon-settings-gear"></i> Configuración.',
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
  if (welcomeGuide) { welcomeGuide.innerHTML = '⏳ <strong>Descargando…</strong> Esto puede tardar unos minutos. Mira la barra de progreso arriba.'; }
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
        '<div style="margin-top:4px;font-size:11px;opacity:.55;">Verifica la conexión o los ajustes de la extensión.</div>';
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
        folderOpt.value = ''; folderOpt.textContent = 'Elige carpeta primero'; folderOpt.selected = true;
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
        if (d.ggufModels && d.ggufModels.length > 0) {
          var ggufSep = document.createElement('option'); ggufSep.disabled = true;
          ggufSep.textContent = '── En tu carpeta (GGUF · nativo) ──'; mSel.appendChild(ggufSep);
          d.ggufModels.forEach(function(m) {
            var opt = document.createElement('option');
            var absPath = m.localPath || m.id;
            var isLoaded = d.loadedGguf && d.loadedGguf.startsWith(absPath);
            opt.value = 'gguf:' + absPath;
            opt.textContent = (isLoaded ? '🟢 ' : '🟠 ') + (m.id ? m.id.split('/').pop() : m.id);
            if (isLoaded) { opt.selected = true; }
            mSel.appendChild(opt);
          });
        }
        if (d.ollamaModels && d.ollamaModels.length > 0) {
          var ollamaSep = document.createElement('option'); ollamaSep.disabled = true;
          ollamaSep.textContent = '── Ollama (usa vía Ollama) ──'; mSel.appendChild(ollamaSep);
          d.ollamaModels.forEach(function(id) {
            var opt = document.createElement('option');
            opt.value = ''; opt.disabled = true;
            opt.textContent = '🟣 ' + id;
            mSel.appendChild(opt);
          });
        }
        var sep = document.createElement('option'); sep.disabled = true; sep.textContent = '── Descargar modelo ──'; mSel.appendChild(sep);
        d.localCatalog.forEach(function(m) {
          if (m.id === d.loadedModel) return;
          var opt = document.createElement('option');
          opt.value = 'download:' + m.id; opt.textContent = m.label + ' (' + m.size + ')' + (m.recommended ? ' ★' : '');
          mSel.appendChild(opt);
        });
        if (!d.loadedModel && (!d.scannedModels || d.scannedModels.length === 0)) {
          var hint = document.createElement('option'); hint.value = ''; hint.textContent = 'Selecciona un modelo para descargar'; hint.selected = true;
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
        var noOpt = document.createElement('option'); noOpt.value = ''; noOpt.textContent = 'Sin modelos — abre LM Studio';
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
