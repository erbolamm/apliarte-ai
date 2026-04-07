# Roadmap — ApliArte AI

Estado actual: **v0.5.0** (publicada)

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

### v0.5 — Modo Agent (actual)
- [x] Backend FastAPI con deploy en VPS
- [x] Tool-calling: readFile, writeFile, listFiles, searchCode, runTerminal
- [x] RAG con embeddings (Ollama + nomic-embed-text)
- [x] SSE streaming entre extensión y backend
- [x] Ejecución local de herramientas con confirmación del usuario
- [x] Guía de deployment paso a paso

---

## Próximas versiones

### v0.6 — Soporte MCP Client ⬅️ SIGUIENTE

> **Objetivo**: Que cualquier usuario pueda conectar servidores MCP (engram, filesystem, GitHub, bases de datos…) y que sus herramientas estén disponibles para el LLM automáticamente.

Este es el cambio más grande desde v0.1. Transforma ApliArte AI de "chat con herramientas fijas" a "hub extensible de herramientas de IA".

#### Fase 1 — Transporte MCP y ciclo de vida

Implementar el protocolo base para comunicarse con servidores MCP.

- [ ] Cliente JSON-RPC 2.0 (`src/mcp/jsonrpc.ts`)
  - Envío/recepción de mensajes con IDs correlativos
  - Manejo de errores JSON-RPC (-32600, -32601, etc.)
  - Timeout configurable por request
- [ ] Transporte stdio (`src/mcp/transport-stdio.ts`)
  - Spawn de proceso hijo con `child_process.spawn`
  - Comunicación por stdin/stdout en formato JSON-RPC
  - Manejo de stderr para logs/debug
- [ ] Transporte SSE (`src/mcp/transport-sse.ts`)
  - Conexión a servidor HTTP remoto
  - Envío por POST, recepción por EventSource/fetch streaming
- [ ] Gestor de servidores (`src/mcp/serverManager.ts`)
  - Start/stop/restart de cada servidor MCP configurado
  - Health monitoring (reconexión automática)
  - Shutdown limpio al desactivar la extensión

**Archivos nuevos**: `src/mcp/jsonrpc.ts`, `src/mcp/transport-stdio.ts`, `src/mcp/transport-sse.ts`, `src/mcp/serverManager.ts`, `src/mcp/types.ts`

#### Fase 2 — Descubrimiento de herramientas y registro dinámico

Reemplazar el switch hardcodeado de 5 herramientas por un registro dinámico.

- [ ] Llamada a `tools/list` en cada servidor conectado
  - Parseo de `inputSchema` (JSON Schema)
  - Merge de herramientas de múltiples servidores
  - Detección de colisiones de nombres
- [ ] Registro unificado de herramientas (`src/mcp/toolRegistry.ts`)
  - Herramientas built-in (las 5 actuales de `executor.ts`)
  - Herramientas MCP descubiertas dinámicamente
  - Cada herramienta sabe a qué servidor pertenece
- [ ] Adaptar `executor.ts` para que consulte el registro
  - Built-in tool → ejecución directa (flujo actual)
  - MCP tool → `tools/call` vía JSON-RPC al servidor correspondiente

**Archivos nuevos**: `src/mcp/toolRegistry.ts`
**Archivos modificados**: `src/tools/executor.ts`

#### Fase 3 — Integración con el LLM

Conectar las herramientas descubiertas con el flujo de chat existente.

- [ ] Inyectar herramientas MCP en la definición de tools del LLM
  - Modo Agent: enviar tools[] combinadas al backend
  - Modo Remote: enviar tools[] directo al LLM (si soporta function calling)
  - Modo Local: inyectar descripciones en el system prompt (modelos pequeños no soportan tool-calling nativo)
- [ ] Adaptar el tool-calling loop de `chatView.ts`
  - Routing: si el LLM llama una herramienta MCP → JSON-RPC `tools/call`
  - Si llama una built-in → executor.ts (sin cambios)
  - Preservar confirmaciones de seguridad para herramientas destructivas
- [ ] Timeout y cancelación por herramienta

**Archivos modificados**: `src/ui/chatView.ts`, `src/core/agentService.ts`

#### Fase 4 — Configuración y UI

- [ ] Setting `apliarteAi.mcpServers` en `package.json`
  ```jsonc
  "apliarteAi.mcpServers": {
    "engram": {
      "command": "engram",
      "args": ["mcp"],
      "env": { "ENGRAM_PROJECT": "${workspaceFolderBasename}" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"]
    }
  }
  ```
- [ ] Indicador de estado por servidor en la UI del chat
  - 🟢 conectado / 🔴 error / 🟡 iniciando
- [ ] Comando `apliarteAi.restartMcpServer` para reiniciar un servidor
- [ ] Mostrar herramientas MCP disponibles en el chat (colapsable)

**Archivos modificados**: `package.json`, `src/ui/chatView.ts`, `src/extension.ts`

#### Fase 5 — Resources y Prompts MCP (opcional en v0.6)

- [ ] Soporte para `resources/list` + `resources/read`
  - Adjuntar recursos MCP como contexto al chat (igual que los archivos del workspace)
- [ ] Soporte para `prompts/list` + `prompts/get`
  - Prompts predefinidos de servidores MCP como acciones rápidas adicionales

---

### v0.7 — Mejoras de UX y persistencia

- [ ] UI mejorada para tool calls (colapsable, con preview)
- [ ] Persistencia de conversaciones (guardar/restaurar historial)
- [ ] Multi-idioma (EN/ES)
- [ ] Auto-indexar workspace al abrir (RAG en modo Agent)

### v0.8 — Integraciones populares

- [ ] Quick-setup para servidores MCP populares:
  - engram (memoria persistente)
  - GitHub (issues, PRs, repos)
  - PostgreSQL / SQLite
  - Browser / Playwright
- [ ] Templates de configuración MCP por stack (Node, Python, Go, etc.)

### v1.0 — Release estable

- [ ] Documentación completa del MCP Client
- [ ] Tests automatizados
- [ ] Marketplace con screenshots actualizados
- [ ] Breaking changes resueltos, API estable

---

## Arquitectura actual vs. MCP

### Hoy (v0.5)

```
Usuario → Chat UI → chatView.ts → agentService.ts → Backend (VPS)
                                                       ↓
                                                    LLM (via AI Gateway)
                                                       ↓
                                                    tool_call event
                                                       ↓
                        chatView.ts ← SSE ← Backend
                            ↓
                        executor.ts (5 herramientas fijas)
                            ↓
                        tool result → Backend → LLM continúa
```

### Con MCP (v0.6)

```
Usuario → Chat UI → chatView.ts → agentService.ts → Backend (VPS)
                                                       ↓
                                                    LLM (via AI Gateway)
                                                       ↓
                                                    tool_call event
                                                       ↓
                        chatView.ts ← SSE ← Backend
                            ↓
                        toolRegistry.ts
                            ├── built-in? → executor.ts
                            └── MCP tool? → serverManager.ts
                                              ↓ JSON-RPC
                                           engram / filesystem / github / ...
                            ↓
                        tool result → Backend → LLM continúa
```

La extensión maneja **todos** los servidores MCP localmente. El backend nunca habla con los MCP servers — eso mantiene la seguridad (herramientas corren donde está tu código).

---

## Principios de diseño

1. **Seguridad primero**: Las herramientas destructivas siempre piden confirmación, vengan de donde vengan.
2. **Progressive disclosure**: MCP es opt-in. Sin configurar nada, todo funciona como antes.
3. **Ejecución local**: Los MCP servers corren en la máquina del usuario. El backend (si se usa) solo coordina con el LLM.
4. **Agnóstico al modelo**: Funciona con modelos locales (transformers.js), remotos (LM Studio/Ollama), y cloud (via Agent backend).
