# Changelog

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
