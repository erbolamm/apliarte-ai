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

#### Feature 1 — Monitor de rendimiento de inferencia local

Problema: el usuario no sabe por qué la generación es lenta. No sabe si el modelo es demasiado grande para su hardware, si WebGPU está activo, ni qué hacer para mejorar la experiencia.

- [x] **Indicador de tokens/segundo** en el toolbar del chat (badge pequeño, aparece al terminar cada respuesta)
  - `localInference.ts`: mide tiempo desde primer token hasta último, cuenta invocaciones del `TextStreamer` callback, calcula `t/s`
  - `StreamOptions.onStats` callback — tipado en `llmService.ts` como `InferenceStats`
  - `ChatProvider`: al recibir stats, actualiza status bar de VS Code (`$(zap) 12.3 t/s`) y postea `inferenceStats` al webview
- [x] **Sugerencia de cambio de modelo** cuando `t/s < 8` (umbral empírico de "experiencia fluida")
  - Banner no invasivo sobre la barra de input: `"Generación lenta (3.2 t/s). ¿Cambiar a Qwen 0.5B para respuestas instantáneas?"` + botón `Cambiar` + botón `✕`
  - El botón aplica el cambio directo sin abrir settings — llama al mismo handler que el `model-select`
  - No se muestra de nuevo por 10 minutos si el usuario lo descarta (localStorage)
- [x] Badge colorea: verde ≥ 8 t/s, naranja 4–8 t/s, rojo < 4 t/s
- [x] Status bar de VS Code muestra `$(zap) 12.3 t/s` durante 8 segundos post-respuesta

**Archivos**: `src/core/llmService.ts`, `src/core/localInference.ts`, `src/ui/chatView.ts`

#### Feature 2 — Zero-Pollution Retrieval (contexto determinista con ripgrep)

Problema: el RAG vectorial inyecta ruido al contexto — resultados vagamente similares semánticamente pero irrelevantes lógicamente. Los modelos pequeños se confunden con ese ruido.

- [x] **Integrar `ripgrep` como motor de búsqueda en modo Agent** — `searchCode` usa `rg` si disponible, fallback a `findFiles`
  - Respeta `.gitignore` nativamente — nunca indexa `node_modules`, `dist`, etc.
  - `ENOENT` → fallback silencioso, sin romper nada si `rg` no está instalado
- [ ] **Extracción de firmas** (solo funciones/clases/interfaces, no el cuerpo completo) para el contexto estructural
  - Patterns por lenguaje: TypeScript/JS, Python, Go, Rust
  - Objetivo: contexto `< 20%` del tamaño de RAG vectorial típico
- [ ] `indexWorkspace` refactorizado: usa `rg --files-with-matches` para listar archivos relevantes

**Archivos**: `src/tools/executor.ts`, `src/core/agentService.ts`, `src/extension.ts`

#### Feature 3 — "Multiverso": alternativas ramificadas de código

Problema: el ciclo real de trabajo con IA es no lineal. Si la primera respuesta no es óptima, el usuario tiene que hacer scroll por un historial largo para comparar variantes.

- [x] **Botón "⟳ Alt"** en cada bloque de código del chat
  - Envía `requestAlternative` con el código original; extensión llama al LLM con micro-prompt focalizado
  - La variante aparece como pestaña `❷` dentro del mismo bloque — no contamina el historial
- [x] **UI de pestañas** `❶ ❷ ❸` — copy/insert/apply siempre usan el tab activo
- [x] Máximo 3 alternativas por bloque
- [x] En modo Local: botón deshabilitado (modelos pequeños no manejan bien la variación)

**Archivos**: `src/ui/chatView.ts`

#### Otros items de v0.9

- [ ] **Jan como proveedor Remote** (`http://localhost:1337/v1` — API OpenAI-compatible)
- [ ] **GGUF nativo**: integrar `node-llama-cpp` (binarios por plataforma) para inferencia sin LM Studio/Ollama
- [ ] Quick-setup para servidores MCP populares:
  - GitHub (issues, PRs, repos)
  - PostgreSQL / SQLite
  - Browser / Playwright
- [ ] Templates de configuración MCP por stack (Node, Python, Go, etc.)

### v1.0 — Release estable

- [ ] Documentación completa del MCP Client
- [ ] Tests automatizados del cliente JSON-RPC y del `toolRegistry`
- [ ] Marketplace con screenshots actualizados
- [ ] Breaking changes resueltos, API estable

---

## Arquitectura actual (v0.8)

```
Modo Remote / Local
─────────────────────────────────────────────────────────────
Usuario → Chat UI → chatView.ts → llmService.streamChatWithTools()
                                       ↓ (OpenAI tool_calls)
                               tool_call event acumulado
                                       ↓
                               toolRegistry.execute()
                                   ├── built-in? → executor.ts
                                   └── MCP tool? → serverManager.ts
                                                     ↓ JSON-RPC
                                                  engram / filesystem / ...
                                       ↓
                               tool result → LLM continúa (loop ≤10)

Modo Agent
─────────────────────────────────────────────────────────────
Usuario → Chat UI → chatView.ts → agentService.streamAgentChat()
                                       ↓ SSE
                               Backend VPS (LLM via AI Gateway)
                                       ↓ tool_call event
                               chatView.ts ← SSE ← Backend
                                       ↓
                               toolRegistry.execute()  (mismo registry)
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
