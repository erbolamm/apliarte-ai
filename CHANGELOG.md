# Changelog

## [0.9.0] - 2026-04-20

### Added
- **Monitor de rendimiento local**: badge `t/s` en el toolbar al terminar cada respuesta — verde ≥ 8, naranja 4–8, rojo < 4. Status bar de VS Code muestra `⚡ 12.3 t/s` 8 segundos post-respuesta
- **Sugerencia de cambio de modelo**: si la generación cae por debajo de 8 t/s, aparece un banner no invasivo sobre la barra de input con botón para cambiar al modelo más rápido. Se descarta con ✕ y no vuelve a aparecer en 10 minutos
- **Botón de carpeta en toolbar**: ícono `📁` visible en modo Local, siempre a mano, sin necesidad de abrir Settings
- **Búsqueda de modelos con ripgrep**: `searchCode` (modo Agent) usa `rg` cuando está disponible — respeta `.gitignore` nativamente, sin ruido de `node_modules`/`dist`. Fallback automático si `rg` no está instalado
- **Alternativas de código "Multiverso"**: botón `⟳ Alt` en cada bloque de código — genera una variante con enfoque diferente, aparece como pestaña `❶ ❷ ❸` sin contaminar el historial. Copiar/Insertar/Aplicar siempre usan la pestaña activa. Máximo 3 alternativas. Deshabilitado en modo Local
- **Scan de modelos mejorado**: detecta 3 layouts (HF cache con verificación de snapshots, repo plano, estructura `org/model/`), soporte para `.gguf`/`.bin`/`.safetensors`/`.onnx`, recursivo un nivel extra. Modelos encontrados en tu carpeta aparecen en el selector bajo "── En tu carpeta ──"

## [0.8.0] - 2026-04-20

### Added
- **HF Hub browser**: buscador integrado de modelos ONNX en HuggingFace — busca por nombre, filtra por descargas, descarga directo a tu carpeta de modelos sin salir de VS Code
- **Gestión de carpeta de modelos**: carpeta única para todos los modelos locales (`apliarteAi.modelsDir`). Picker con `showOpenDialog`, scan automático de repos HF cache y planos. El modo Local no arranca hasta elegir carpeta
- **UI de tool calls mejorada**: bloque colapsable con preview de argumentos y resultado de cada herramienta — separado visualmente del texto del LLM
- **MCP Resources y Prompts** (Fase 6): `resources/list` + `resources/read` para adjuntar recursos como contexto; `prompts/list` + `prompts/get` para acciones rápidas predefinidas desde servidores MCP
- **Multi-idioma EN/ES real**: `applyLang()` con mapa de 35+ keys, activación instantánea sin reiniciar VS Code; selector en settings cambia idioma en vivo
- **RAG auto-index al abrir**: indexa el workspace automáticamente al iniciar en modo Agent (background, sin interrumpir)
- **RAG incremental al guardar**: actualiza el índice RAG al guardar archivos de texto (debounced 3s, ignora node_modules/dist/etc.)
- **MCP local quick-setup**: botones preconfigurados en Settings para añadir `@modelcontextprotocol/server-memory` (memoria) y `@modelcontextprotocol/server-filesystem` (archivos) con un solo click
- **Botones de soporte en Settings**: PayPal, Ko-fi y Twitch Tip visibles desde la configuración inline

### Changed
- Agente remoto renombrado a "Agente Remoto" genérico — sin referencias hardcoded a ningún servidor específico
- Settings de Engram MCP marcado como obsoleto (`markdownDeprecationMessage`) — migrar a `apliarteAi.mcpServers`
- Carpeta de modelos requiere selección antes de usar modo Local

### Fixed
- Eliminar conversación no funcionaba: `confirm()` está bloqueado en webviews de VS Code y retorna `undefined`. Reemplazado por patrón de doble click (primer click → icono ⚠️ 2,5s → segundo click confirma)

## [0.7.0] - 2026-04-19

### Added
- **MCP Client genérico** — ApliArte AI se convierte en un hub extensible de herramientas de IA
- **Transporte stdio**: spawn de procesos locales con SIGTERM/SIGKILL al cerrar. Compatible con cualquier servidor MCP que use stdio
- **Transporte HTTP (MCP Streamable HTTP)**: cliente HTTP con session ID para servidores MCP remotos
- **Gestor multi-server** (`McpServerManager`): ciclo de vida de N servidores con `sync`/`restart`/`onDidChange`
- **Descubrimiento dinámico**: `tools/list` por servidor, namespace `{server}.{toolName}`, `ToolRegistry` unificado (builtin + MCP)
- **Tool-calling en modo Remote**: `streamChatWithTools` con loop hasta 10 iteraciones, protocolo OpenAI. LM Studio y Ollama ya soportan tool-calling
- **Tool-calling en modo Agent**: tools MCP disponibles en el backend vía el mismo registry unificado
- **Configuración `apliarteAi.mcpServers`** con JSON Schema completo — transporte, args, env, cwd, headers
- **Comandos de gestión MCP**: `ApliArte AI: Reiniciar servidor MCP` y `ApliArte AI: Estado de servidores MCP`
- **Badges de estado MCP** en la toolbar del chat, panel colapsable de tools por servidor
- **Migración automática** de `apliarteAi.engramEndpoint` → `apliarteAi.mcpServers.engram`
- **Nota inline en modo Local** cuando el modelo pequeño no soporta tool-calling
- Timeout por herramienta: 30s

### Changed
- `engramService.ts` eliminado — interacción con Engram 100% vía MCP tool-calling del LLM
- Panel UI de Engram eliminado — estado visible en badges MCP
- `executor.ts` delega al `ToolRegistry` unificado en vez de implementar herramientas directamente

### Breaking
- `apliarteAi.engramEndpoint` deprecado — migrar a `apliarteAi.mcpServers`. La migración automática cubre la mayoría de los casos

## [0.6.5] - 2026-04-18

### Fixed
- Modelo `Qwen2.5-3B-Instruct` eliminado del catálogo — el repo en HuggingFace requiere autenticación (401). Reemplazado por `Qwen2.5-Coder-3B-Instruct`, que es público y más apropiado para asistente de código

## [0.6.4] - 2026-04-18

### Fixed
- Error al iniciar inferencia local: `import()` de directorio no soportado en contexto ESM de Node.js — ahora apunta al entry point concreto `dist/transformers.node.cjs`

## [0.6.3] - 2026-04-17

### Fixed
- Barra de progreso de descarga de modelos locales: ahora se muestra correctamente durante toda la descarga
- Descarga de modelo desde botón "Descargar modelo recomendado" fallaba silenciosamente si las dependencias (transformers.js) no estaban instaladas
- Manejo de estados intermedios de descarga (`initiate`, `ready`, `download`) que antes se ignoraban
- Mensaje de error visible en la pantalla de bienvenida cuando la descarga falla, en lugar de esconder la barra sin feedback

## [0.6.2] - 2026-04-16

> Bump de versión sin cambios funcionales.

## [0.6.1] - 2026-04-15

### Fixed
- Welcome screen contextual: guía paso a paso según el proveedor seleccionado
- Botón "Descargar modelo recomendado" visible desde el arranque en modo Local
- UX: mensajes de guía para modo Remote offline y Agent sin configurar

## [0.6.0] - 2026-04-15

### Added
- **Persistencia multi-conversación**: historial guardado entre sesiones con nombres automáticos, timestamps y preview. Hasta 50 conversaciones en paralelo
- **Sidebar de conversaciones**: listado colapsable con cada sesión, contador de mensajes y preview del primer mensaje
- **Gestión completa de conversaciones**: crear nueva, cargar, renombrar inline (click en ✏️), eliminar y exportar por separado
- **Exportar todo a Markdown**: una sola acción exporta todas las conversaciones en un documento estructurado
- **Panel de configuración inline**: modal dentro del chat para configurar endpoints, API keys, preset e idioma sin abrir VS Code Settings
- **Engram MCP integrado**: panel de búsqueda y guardado de memorias persistentes. Badge 🧠 indica cuando Engram está conectado
- **Welcome screen contextual**: la pantalla de inicio se adapta al proveedor seleccionado con guía paso a paso
- **Botón de descarga prominente**: en modo Local aparece un botón "Descargar modelo recomendado" para arrancar sin adivinar
- **Menú export dropdown**: opción de exportar la conversación actual o todas a la vez
- Nueva configuración `apliarteAi.engramEndpoint` para conectar con el servidor Engram MCP

### Changed
- Migración automática del historial plano anterior (v0.5.x) al nuevo sistema multi-conversación
- Layout en dos columnas: sidebar + área de chat independiente

### Fixed
- La extensión ya no pierde el historial al cerrar y reabrir VS Code (persistencia real con `globalState`)

## [0.5.3] - 2026-04-07

### Added
- Persistencia de conversaciones: el historial se mantiene al cambiar de vista y entre sesiones
- Soporte para Ollama: el modo Remote detecta automáticamente LM Studio u Ollama

### Fixed
- Mensajes de error actualizados para mencionar Ollama además de LM Studio

## [0.5.2] - 2026-04-07

### Fixed
- Corregido icono del sidebar (activitybar no soporta formato dark/light object)
- SVG del sidebar usa colores compatibles con theming de VS Code

## [0.5.1] - 2026-04-07

### Fixed
- Nuevo icono: chevron ApliArte + chat bubble (reemplaza el chip+A viejo)
- Sidebar usa iconos dark/light SVG según el tema
- icon.svg limpio sin restos del diseño anterior

## [0.5.0] - 2026-04-07

### Added
- **Modo Agent (Cloud)**: Backend FastAPI propio con tool-calling (readFile, writeFile, listFiles, searchCode, runTerminal) y RAG con embeddings
- Streaming SSE entre la extensión y el servidor Agent
- Ejecución local de herramientas con confirmación del usuario para acciones destructivas
- Guía de deployment paso a paso para VPS (server/README.md)
- Comando "Indexar workspace (RAG)" para que el agente conozca tu proyecto
- Hoja de ruta técnica detallada (ROADMAP.md)

### Changed
- Iconos de la interfaz: emojis reemplazados por codicon (iconos nativos de VS Code)
- Textos de la UI normalizados a castellano estándar
- Roadmap actualizado: MCP Client planificado para v0.6

## [0.4.0] - 2026-04-06

### Added
- **Inferencia local sin dependencias**: Corre modelos de IA directamente en VS Code usando transformers.js v4 + WebGPU. No necesitas instalar LM Studio ni Ollama.
- Selector de proveedor: "Local (sin instalar nada)" vs "LM Studio / Ollama"
- Catálogo de modelos ONNX pre-verificados (Qwen 2.5 0.5B/1.5B/3B, SmolLM2 360M)
- Descarga de modelos con barra de progreso integrada
- Modelos se cachean localmente después de la primera descarga

### Changed
- Descripción actualizada para reflejar la nueva capacidad de inferencia local

## [0.3.0] - 2026-04-05

### Added
- Chat con streaming y markdown
- Bloques de código con syntax highlighting, copiar, insertar y diff/apply
- Explorador de workspace con selección de archivos
- Quick actions (explicar, refactorizar, bugs, tests, docs, optimizar)
- Recomendador de modelos según hardware
- Detección automática de LM Studio y Ollama
- Export de chat a markdown
- Indicador de conexión con reintento automático
- Selector de temperatura
- 3 presets de sistema (minimal, ecosystem-only, full-gentleman)
