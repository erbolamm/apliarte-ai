# Changelog

## [0.4.0] - 2026-04-06

### Added
- **Inferencia local sin dependencias**: Corre modelos de IA directamente en VS Code usando transformers.js v4 + WebGPU. No necesitás instalar LM Studio ni Ollama.
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
