# Roadmap — ApliArte AI

Estado actual: **v0.8.0** lista para publicar · **v0.9** siguiente

> **¿Primera vez?** Leé la [Guía de usuario](GUIDE.md) — explica instalación, modos, MCP y todo lo demás en lenguaje simple.

---

## Visión

ApliArte AI empezó como un chat de IA local y privado para VS Code. La visión a medio plazo es convertirlo en un **hub de herramientas de IA** — donde cualquier usuario pueda conectar los servidores MCP que necesite (memoria persistente, bases de datos, GitHub, filesystem avanzado, etc.) y usar modelos gratuitos o de pago, locales o en la nube, todo desde una misma interfaz.

---

## Versiones completadas

### v0.1 — Detección de proveedores
- [x] Detección automática de LM Studio y Ollama
- [x] Indicador de conexión

### v0.2 — Chat con streaming
- [x] Streaming en tiempo real
- [x] Respuestas en markdown con syntax highlighting
- [x] Botones de copiar, insertar y aplicar diff

### v0.3 — Workspace y acciones rápidas
- [x] Workspace explorer con checkbox para adjuntar archivos
- [x] Acciones rápidas (explicar, refactorizar, buscar bugs, tests, documentar, optimizar)
- [x] Recomendador de modelos según hardware

### v0.4 — Inferencia local
- [x] Modelos ONNX con transformers.js v4 directo en VS Code
- [x] Catálogo de modelos preconfigurados (Qwen 2.5, SmolLM2)
- [x] Descarga automática con barra de progreso

### v0.5 — Modo Agent
- [x] Backend FastAPI con deploy en VPS
- [x] Tool-calling: readFile, writeFile, listFiles, searchCode, runTerminal
- [x] RAG con embeddings (Ollama + nomic-embed-text)
- [x] SSE streaming entre extensión y backend
- [x] Ejecución local de herramientas con confirmación del usuario
- [x] Guía de deployment paso a paso

### v0.6 — Persistencia, Engram y UX

> **Nota**: El scope original de v0.6 era un **cliente MCP genérico**. Se re-priorizó para resolver antes dos dolores reales: pérdida de historial al cerrar VS Code y falta de memoria cross-session. El cliente MCP genérico se movió a v0.7.

- [x] Persistencia multi-conversación con nombres automáticos, timestamps y preview (hasta 50 en paralelo)
- [x] Sidebar de conversaciones: crear, cargar, renombrar inline, eliminar, exportar
- [x] Exportar todas las conversaciones a Markdown
- [x] Panel de configuración inline (modal dentro del chat)
- [x] Engram MCP integrado vía HTTP (`apliarteAi.engramEndpoint`) — servidor único hardcoded
- [x] Badge de estado de Engram en la UI
- [x] Welcome screen contextual según proveedor (Local / Remote / Agent)
- [x] Botón "Descargar modelo recomendado" visible desde el arranque en modo Local
- [x] Migración automática del historial plano anterior (v0.5.x)
- [x] Fix barra de progreso de descarga (v0.6.3)
- [x] Fix `import()` de directorio en transformers.js (v0.6.4)
- [x] Catálogo actualizado: Qwen2.5-Coder-3B-Instruct en vez del gated Qwen2.5-3B-Instruct (v0.6.5)

**Archivos clave**:
- `src/core/conversationStore.ts` — persistencia multi-conversación
- `src/ui/chatView.ts` — sidebar, settings inline, welcome screen

### v0.7 — MCP Client genérico

> Transforma ApliArte AI de "chat con herramientas fijas + Engram hardcoded" a "hub extensible de herramientas de IA". Cualquier servidor MCP (engram, filesystem, GitHub…) se conecta via `apliarteAi.mcpServers` y sus herramientas quedan disponibles para el LLM automáticamente.

- [x] **Fase 1 — Transporte y ciclo de vida**: cliente JSON-RPC 2.0, transporte stdio (spawn + SIGTERM/SIGKILL) y HTTP (MCP Streamable HTTP, session ID), gestor multi-server con `sync`/`restart`/`onDidChange`
- [x] **Fase 2 — Descubrimiento dinámico**: `tools/list` por servidor, namespace `{server}.{toolName}`, `ToolRegistry` unificado (builtin + MCP con discriminated union), `executor.ts` delega al registry
- [x] **Fase 3 — Integración LLM**: tool-calling en modo Agent (ya existía), Remote (`streamChatWithTools` con loop hasta 10 iter, protocolo OpenAI), nota inline en Local (modelos pequeños no soportan tool-calling), timeout per-tool 30s
- [x] **Fase 4 — Configuración y UI**: setting `apliarteAi.mcpServers` con JSON Schema, migración automática `engramEndpoint` → `mcpServers.engram`, comandos `restartMcpServer` y `showMcpStatus`, badges de estado en toolbar, panel colapsable de tools por server
- [x] **Fase 5 — Engram sobre MCP**: eliminado `engramService.ts` y panel UI de Engram — interacción 100% vía MCP tool-calling del LLM. Estado visible en `#mcp-badges`

**Archivos nuevos**: `src/mcp/jsonrpc.ts`, `src/mcp/transport-stdio.ts`, `src/mcp/transport-http.ts`, `src/mcp/serverManager.ts`, `src/mcp/toolRegistry.ts`, `src/mcp/types.ts`  
**Archivos modificados**: `src/ui/chatView.ts`, `src/core/llmService.ts`, `src/tools/executor.ts`, `src/extension.ts`, `package.json`  
**Archivos eliminados**: `src/core/engramService.ts`

### v0.8 — UX, gestión de modelos y RAG ✅

- [x] **Gestión de modelos locales — flujo completo de carpeta + descargas**
  - Prompt al instalar/actualizar: detecta primera ejecución y upgrades, muestra picker de carpeta
  - Setting `apliarteAi.modelsDir` — ruta única para todos los modelos (disco externo, SD card, etc.)
  - Folder picker con `vscode.window.showOpenDialog`
  - Scan automático: detecta HF cache layout + repos planos (config.json + safetensors/onnx)
  - Descarga dirigida: todas las descargas respetan `modelsDir`
  - Badge en welcome screen y settings mostrando la carpeta activa
- [x] **HF Hub browser**: buscar modelos ONNX en HuggingFace, filtrado por descargas, descarga directa a `modelsDir`
- [x] **UI de tool calls mejorada**: colapsable con preview de argumentos y resultado, separado del texto del LLM
- [x] **Resources y Prompts MCP** (Fase 6):
  - `resources/list` + `resources/read` — adjuntar recursos como contexto
  - `prompts/list` + `prompts/get` — prompts predefinidos como acciones rápidas
- [x] Multi-idioma EN/ES real: `applyLang()` con mapa de 35 keys, activación instantánea sin reiniciar
- [x] Auto-indexar workspace al abrir (RAG en modo Agent, silent background)
- [x] Actualización incremental del índice RAG al guardar (debounced 3s, solo archivos texto)
- [x] Botones de soporte integrados en Settings: PayPal, Ko-fi, Twitch Tip

**Archivos modificados**: `src/ui/chatView.ts`, `src/core/localInference.ts`, `src/mcp/resourceRegistry.ts`, `src/extension.ts`, `package.json`

---

## Próximas versiones

### v0.9 — Rendimiento local, contexto quirúrgico y UX avanzada

> **Estado**: parcialmente completo. Features 1 y 3 terminadas. Feature 2 y los "Otros items" pendientes.

#### Feature 1 — Monitor de rendimiento ✅ COMPLETO

- [x] Badge `t/s` en toolbar (verde ≥ 8, naranja 4–8, rojo < 4)
- [x] Status bar `⚡ 12.3 t/s` durante 8s post-respuesta
- [x] Slow-banner con sugerencia de modelo más rápido (cooldown 10 min via localStorage)
- [x] `InferenceStats` + `onStats` callback en `StreamOptions`

#### Feature 2 — Zero-Pollution Retrieval (pendiente)

Problema: el RAG vectorial inyecta ruido — resultados semánticamente parecidos pero lógicamente irrelevantes. Los modelos pequeños se confunden.

**2a — ripgrep en searchCode** ✅ COMPLETO
- [x] `searchCode` usa `rg` si disponible, fallback silencioso a `findFiles`
- [x] Respeta `.gitignore` — nunca toca `node_modules/dist`
- [x] `ENOENT` → fallback automático sin romper nada

**2b — Extracción de firmas** ✅ COMPLETO

Objetivo: cuando el agente necesita entender la estructura de un archivo, enviarle SOLO las firmas (función/clase/interfaz) sin el cuerpo. Reduce el contexto a <20% del tamaño original.

Implementación en `src/tools/executor.ts` — nueva herramienta `extractSignatures(filePath)`:

```typescript
// Patterns por lenguaje (usar con rg --multiline-dotall o línea a línea)
const SIGNATURE_PATTERNS: Record<string, string[]> = {
  ts: [
    '^(export\\s+)?(default\\s+)?(async\\s+)?function[\\s*]\\w+',
    '^(export\\s+)?(abstract\\s+)?class\\s+\\w+',
    '^(export\\s+)?interface\\s+\\w+',
    '^(export\\s+)?type\\s+\\w+\\s*[=<]',
    '^(export\\s+)?const\\s+\\w+\\s*=\\s*(async\\s+)?\\(',   // arrow functions
  ],
  py: [
    '^(async\\s+)?def\\s+\\w+',
    '^class\\s+\\w+',
  ],
  go: [
    '^func\\s+(\\(\\w+\\s+\\*?\\w+\\)\\s+)?\\w+',
    '^type\\s+\\w+\\s+(struct|interface)',
  ],
  rs: [
    '^(pub(\\(\\w+\\))?\\s+)?(async\\s+)?fn\\s+\\w+',
    '^(pub(\\(\\w+\\))?\\s+)?struct\\s+\\w+',
    '^(pub(\\(\\w+\\))?\\s+)?trait\\s+\\w+',
    '^(pub(\\(\\w+\\))?\\s+)?enum\\s+\\w+',
  ],
};

// Llamada: rg --line-number --no-heading --smart-case -e PATTERN file
// Concatenar resultados de todos los patterns del lenguaje detectado
// Retornar: "file.ts — 12 signatures found\n  L4: export function foo(...\n  L18: class Bar..."
```

Añadir al `ToolRegistry` como built-in tool disponible en Agent y Remote.

**2c — `indexWorkspace` refactorizado** ✅ COMPLETO

En `src/core/agentService.ts`, la función `indexWorkspace` actualmente usa `vscode.workspace.findFiles`. Refactorizar para que use `rg --files` cuando disponible:

```typescript
// Antes: vscode.workspace.findFiles('**/*', excludePattern)
// Después:
async function listWorkspaceFiles(root: string): Promise<string[]> {
  try {
    const out = await execRg(['--files', '--follow'], root);
    return out.split('\n').filter(Boolean);
  } catch {
    // fallback a findFiles
    const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/dist/**}');
    return uris.map(u => u.fsPath);
  }
}
```

**Archivos a modificar**: `src/tools/executor.ts`, `src/core/agentService.ts`

#### Feature 3 — Multiverso ✅ COMPLETO

- [x] Botón `⟳ Alt` en bloques de código
- [x] Pestañas `❶ ❷ ❸` — copy/insert/apply usan tab activo
- [x] Máximo 3 alternativas por bloque
- [x] Deshabilitado en modo Local

#### Feature 4 — Jan como proveedor Remote ✅ COMPLETO

Jan es una app local de IA con API OpenAI-compatible en `http://localhost:1337/v1`.
Misma integración que LM Studio/Ollama — solo hay que agregarlo a la detección automática.

**Cambios en `src/core/llmService.ts`**:

```typescript
// En testConnection() / detectProvider() — agregar Jan al auto-scan:
const REMOTE_CANDIDATES = [
  { name: 'LM Studio', base: 'http://localhost:1234/v1' },
  { name: 'Ollama',    base: 'http://localhost:11434/v1' },
  { name: 'Jan',       base: 'http://localhost:1337/v1' },   // ← NUEVO
];

// Cada candidato: GET /models, si responde con { data: [...] } → conectado
// Guardar el base URL del que responde primero
```

**Cambios en `src/ui/chatView.ts`**:

- En la UI de connectionStatus: mostrar "Jan" como nombre cuando el endpoint es `1337`
- En `_getWebviewContent()`: añadir Jan al texto del placeholder del endpoint input

**Archivos a modificar**: `src/core/llmService.ts`, `src/ui/chatView.ts`

#### Feature 5 — GGUF nativo con node-llama-cpp ✅ COMPLETO

Permite cargar modelos `.gguf` directamente, sin LM Studio ni Ollama. Complementa el modo Local actual (que solo soporta ONNX via transformers.js).

**Nuevo archivo**: `src/core/ggufInference.ts` — paralelo a `localInference.ts`:

```typescript
// Instala node-llama-cpp on-demand en globalStorageUri (igual que transformers.js)
// Usa LlamaModel + LlamaContext + LlamaChatSession de node-llama-cpp
// Expone: loadGgufModel(path), streamChatGguf(messages, onChunk, options)
// Detecta plataforma: darwin/linux/win32 — node-llama-cpp tiene binarios precompilados

export async function installGgufDeps(onProgress?: (msg: string) => void): Promise<void> {
  // npm install --production node-llama-cpp en depsDir
}

export async function loadGgufModel(
  filePath: string,  // ruta absoluta al .gguf
  onProgress?: (pct: number) => void
): Promise<void> {
  // const { getLlama, LlamaChatSession } = await import(ggufPath)
  // _llama = await getLlama()
  // _model = await _llama.loadModel({ modelPath: filePath })
  // _context = await _model.createContext()
}

export async function streamChatGguf(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options?: StreamOptions
): Promise<void> {
  // const session = new LlamaChatSession({ contextSequence: _context.getSequence() })
  // await session.prompt(lastUserMessage, { onTextChunk: onChunk, signal: options?.signal })
}
```

**Integración en `chatView.ts`**:
- En el model selector: bajo "── GGUF (nativo) ──" listar los `.gguf` encontrados en `modelsDir`
- `scanModelsDir` ya detecta `.gguf` — solo hay que filtrarlos y mostrarlos por separado
- Al seleccionar: llamar `loadGgufModel(absolutePath)` en vez de `loadModel(modelId)`

**Archivos nuevos/modificados**: `src/core/ggufInference.ts`, `src/ui/chatView.ts`, `src/core/localInference.ts` (reexport utils comunes)

#### Feature 6 — Quick-setup MCP populares ✅ COMPLETO

Ya existe el patrón en `chatView.ts` para añadir `server-memory` y `server-filesystem` con 1 click. Extender con más servidores.

**Cambios solo en `src/ui/chatView.ts`** — sección de Settings, función `_getMcpQuickSetups()`:

```typescript
const MCP_QUICK_SETUPS = [
  // Ya implementados:
  { id: 'memory',     label: '🧠 Memoria persistente',  pkg: '@modelcontextprotocol/server-memory',     args: [] },
  { id: 'filesystem', label: '📁 Filesystem',            pkg: '@modelcontextprotocol/server-filesystem', args: [vscode.workspace.rootPath ?? ''] },
  // NUEVOS:
  {
    id: 'github',
    label: '🐙 GitHub',
    pkg: '@modelcontextprotocol/server-github',
    args: [],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },   // usuario rellena después
    note: 'Requiere GITHUB_PERSONAL_ACCESS_TOKEN en la config del servidor',
  },
  {
    id: 'postgres',
    label: '🐘 PostgreSQL',
    pkg: '@modelcontextprotocol/server-postgres',
    args: [],
    env: { POSTGRES_CONNECTION_STRING: 'postgresql://user:pass@localhost/db' },
    note: 'Ajustá POSTGRES_CONNECTION_STRING en la config',
  },
  {
    id: 'sqlite',
    label: '🗃️ SQLite',
    pkg: '@modelcontextprotocol/server-sqlite',
    args: ['--db-path', '${workspaceFolder}/db.sqlite'],
  },
  {
    id: 'playwright',
    label: '🎭 Browser (Playwright)',
    pkg: '@playwright/mcp',
    args: [],
    note: 'Permite al LLM navegar por el browser y hacer screenshots',
  },
];
```

Al hacer click en un botón: genera el objeto de config `mcpServers` y lo escribe vía `vscode.workspace.getConfiguration('apliarteAi').update('mcpServers', ...)`.

#### Feature 7 — Templates de config MCP por stack ✅ COMPLETO

En Settings, sección "Plantillas de inicio rápido". Selector de stack que pre-configura un conjunto de servidores MCP de golpe.

```typescript
const MCP_STACK_TEMPLATES = {
  'Node.js / TypeScript': ['memory', 'filesystem', 'github'],
  'Python':               ['memory', 'filesystem', 'postgres'],
  'Go':                   ['memory', 'filesystem', 'github'],
  'Full-stack web':        ['memory', 'filesystem', 'github', 'playwright'],
};
// Al aplicar: añade todos los servidores del stack de una sola vez
```

**Archivos a modificar**: solo `src/ui/chatView.ts`

---

### v1.0 — Release estable

Foco: calidad, estabilidad y documentación. Sin features nuevas grandes.

#### 1.0.1 — Tests del cliente MCP

- [ ] Tests unitarios para `src/mcp/jsonrpc.ts`: serialización/deserialización JSON-RPC 2.0, IDs de requests, manejo de errores, batch requests
- [ ] Tests de integración para `src/mcp/serverManager.ts`: spawn/stop/restart de proceso stdio, reconexión HTTP, timeout handling
- [ ] Tests para `src/mcp/toolRegistry.ts`: namespace collision, builtin vs MCP dispatch, tool not found
- [ ] Framework: `@vscode/test-cli` + `mocha` (ya en devDependencies)
- [ ] Añadir script `"test": "vscode-test"` al `package.json`

#### 1.0.2 — Documentación del MCP Client

- [ ] `docs/mcp.md`: guía completa — qué es MCP, cómo configurar `apliarteAi.mcpServers`, ejemplos para cada transporte
- [ ] `docs/mcp.md`: sección "Crear tu propio servidor MCP" con ejemplo mínimo en TypeScript y Python
- [ ] Actualizar `GUIDE.md` con sección MCP
- [ ] Actualizar `README.md` con tabla de servidores MCP verificados

#### 1.0.3 — Estabilidad de API y breaking changes

- [ ] Deprecar formalmente `apliarteAi.engramEndpoint` (ya marcado) — eliminar en v1.0
- [ ] Revisar todos los `settings` en `package.json`: descripciones completas, ejemplos, valores por defecto correctos
- [ ] Asegurar que `chatView.ts` no use `innerHTML` con contenido sin sanitizar (XSS en webview)

#### 1.0.4 — Marketplace

- [ ] Screenshots actualizados (v0.9 UI — sidebar conversaciones, MCP badges, Multiverso tabs, t/s badge)
- [ ] GIF animado en README mostrando el flujo completo: Local → chat → Alt → aplicar diff
- [ ] Categorías y tags del Marketplace revisados

---

## Arquitectura actual (v0.9)

```
Modo Remote / Local
─────────────────────────────────────────────────────────────
Usuario → Chat UI → chatView.ts → llmService.streamChatWithTools()
                                       ↓ (OpenAI tool_calls)
                               tool_call event acumulado
                                       ↓
                               toolRegistry.execute()
                                   ├── built-in? → executor.ts
                                   │       ├── readFile / writeFile / listFiles
                                   │       ├── searchCode  ← rg + fallback findFiles
                                   │       ├── extractSignatures  (v0.9 pendiente)
                                   │       └── runTerminal
                                   └── MCP tool? → serverManager.ts
                                                     ↓ JSON-RPC
                                                  engram / filesystem / github / ...
                                       ↓
                               tool result → LLM continúa (loop ≤10)

Modo Local (inferencia en proceso)
─────────────────────────────────────────────────────────────
Usuario → Chat UI → chatView.ts → localInference.streamChatLocal()
                                       ↓ TextStreamer callback
                               chunk por chunk → webview
                                       ↓ onStats callback
                               InferenceStats { t/s, tokens, model }
                                       ↓
                               chatView._handleInferenceStats()
                                   ├── status bar ⚡ 12.3 t/s (8s)
                                   ├── tps-badge en toolbar
                                   └── slow-banner si t/s < 8

Modo Agent
─────────────────────────────────────────────────────────────
Usuario → Chat UI → chatView.ts → agentService.streamAgentChat()
                                       ↓ SSE
                               Backend VPS (LLM via AI Gateway)
                                       ↓ tool_call event
                               chatView.ts ← SSE ← Backend
                                       ↓
                               toolRegistry.execute()  (mismo registry que Remote)
                                   ├── built-in? → executor.ts
                                   └── MCP tool? → serverManager.ts
                                                     ↓ JSON-RPC
                                                  engram / filesystem / ...
                                       ↓
                               tool result → Backend → LLM continúa
```

Los MCP servers siempre corren en la máquina del usuario. El backend (si se usa) nunca habla con ellos directamente — eso mantiene la seguridad.

---

## Principios de diseño

1. **Seguridad primero**: Las herramientas destructivas siempre piden confirmación, vengan de donde vengan.
2. **Progressive disclosure**: MCP es opt-in. Sin configurar nada, todo funciona como antes.
3. **Ejecución local**: Los MCP servers corren en la máquina del usuario. El backend solo coordina con el LLM.
4. **Agnóstico al modelo**: Funciona con modelos locales (transformers.js), remotos (LM Studio/Ollama), y cloud (via Agent backend).
5. **Backwards compat**: Cada cambio mantiene la config existente funcionando al menos un par de versiones antes de deprecar.
