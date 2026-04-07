# Changelog

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
