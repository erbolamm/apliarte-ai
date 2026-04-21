<p align="center">
  <img src="icon.png" alt="ApliArte AI" width="128" />
</p>

<h1 align="center">ApliArte AI</h1>

<p align="center">
  <strong>Chat de IA 100% local para VS Code.</strong><br>
  Corre modelos directamente en tu máquina — sin APIs externas, sin cuentas, sin coste.<br>
  También conecta LM Studio y Ollama si ya los usas.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=apliarte.apliarte-ai">
    <img src="https://img.shields.io/visual-studio-marketplace/v/apliarte.apliarte-ai?label=Marketplace&color=blue" alt="VS Marketplace Version" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=apliarte.apliarte-ai">
    <img src="https://img.shields.io/visual-studio-marketplace/i/apliarte.apliarte-ai?label=Installs&color=green" alt="VS Marketplace Installs" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/erbolamm/apliarte-ai" alt="License" />
  </a>
</p>

<p align="center">
  <a href="https://erbolamm.github.io/apliarte-ai/">🌐 Web</a> · 
  <a href="https://marketplace.visualstudio.com/items?itemName=apliarte.apliarte-ai">VS Marketplace</a> · 
  <a href="https://open-vsx.org/extension/apliarte/apliarte-ai">Open VSX (Cursor/Windsurf/Antigravity)</a>
</p>

---

## Por qué ApliArte AI

La mayoría de extensiones de IA para VS Code requieren una API key de pago o envían tu código a la nube. ApliArte AI es diferente:

- **Sin internet**: Todo corre en tu máquina. Tu código nunca sale de tu ordenador.
- **Sin cuentas**: No necesitas registrarte en ningún servicio.
- **Sin coste**: Modelos open-source, gratis para siempre.
- **Cuatro modos**: Inferencia local (transformers.js v4), LM Studio/Ollama, Agent Cloud con tu propio servidor, y herramientas externas vía MCP.
- **Extensible**: Conecta cualquier servidor MCP (memoria persistente, filesystem, GitHub, bases de datos…) con un solo setting.

---

## Funcionalidades

### Chat con IA local

- Streaming en tiempo real con respuestas en markdown
- Bloques de código con syntax highlighting
- Botones de **copiar**, **insertar en editor** y **aplicar diff** en cada bloque
- **Persistencia multi-conversación**: historial guardado entre sesiones, hasta 50 conversaciones en paralelo
- Sidebar con listado, renombrar inline, exportar a Markdown
- Control de temperatura para ajustar creatividad
- Interfaz en **Español e Inglés** (cambia sin reiniciar VS Code)

### Inferencia local (modo Local)

- Corre modelos ONNX directamente en VS Code usando [transformers.js v4](https://github.com/huggingface/transformers.js)
- No necesitas instalar nada externo — las dependencias se descargan automáticamente la primera vez
- **Carpeta de modelos configurable**: apunta a un disco externo, tarjeta SD o cualquier ruta con `apliarteAi.modelsDir`
- **Recomendador de modelos por hardware**: detecta tu RAM automáticamente y muestra solo los modelos que entran en tu equipo, con indicador de soporte de herramientas MCP (🔧) y RAM requerida
- **HF Hub browser**: búsqueda libre en HuggingFace para usuarios avanzados
- Barra de progreso durante la descarga del modelo

### Conexión con LM Studio / Ollama (modo Remoto)

- Detección automática de LM Studio y Ollama
- Selector de modelo entre los cargados en tu servidor local
- Indicador de conexión con reintento automático
- **Tool-calling real**: las herramientas MCP están disponibles para el LLM cuando el modelo lo soporta

### Modo Agent (tu propio servidor)

- Conecta la extensión a un backend propio desplegado en un VPS
- El modelo de IA corre en la nube (OpenAI, Anthropic, Google, Groq…) — tú eliges cuál
- **Herramientas de código**: leer archivos, escribir código, buscar en tu proyecto y ejecutar comandos — todo con tu aprobación
- **RAG automático**: indexa tu workspace al abrir y actualiza el índice al guardar (background, sin interrumpir)
- Las herramientas se ejecutan **localmente en tu máquina** — el servidor solo coordina con el modelo de IA
- Confirmación obligatoria antes de escribir archivos o ejecutar comandos en terminal

### MCP Client — Herramientas externas

Conecta cualquier servidor MCP y sus herramientas quedan disponibles para el LLM automáticamente:

```jsonc
// settings.json
"apliarteAi.mcpServers": {
  "memory": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"]
  },
  "filesystem": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/ruta/a/tu/proyecto"]
  }
}
```

**Servidores verificados:**

| Servidor | Paquete | Herramientas |
|----------|---------|-------------|
| Memoria | `@modelcontextprotocol/server-memory` | Contexto persistente entre sesiones |
| Filesystem | `@modelcontextprotocol/server-filesystem` | Leer/escribir archivos |
| GitHub | `@modelcontextprotocol/server-github` | Issues, PRs, búsqueda de código |
| PostgreSQL | `@modelcontextprotocol/server-postgres` | Consultas SQL |
| SQLite | `@modelcontextprotocol/server-sqlite` | Bases de datos locales |
| Browser | `@playwright/mcp` | Navegar webs, screenshots |

- **Transporte stdio**: servidores locales (spawn de procesos)
- **Transporte HTTP**: servidores MCP remotos (MCP Streamable HTTP)
- Badges de estado en tiempo real en la toolbar
- Quick-setup con un click + plantillas por stack (Node/Python/Go/Full-stack)
- **MCP Resources**: adjunta recursos de servidores MCP como contexto
- **MCP Prompts**: acciones rápidas predefinidas desde servidores MCP

[Documentación completa del cliente MCP →](docs/mcp.md)

### Bloques de tool calls

Cada vez que el LLM llama a una herramienta, aparece un bloque visual colapsable con:
- Nombre de la herramienta y servidor
- Preview de los argumentos
- Resultado devuelto

Separado del texto del LLM para no mezclar razonamiento con ejecución.

### Explorador de workspace

- Árbol de archivos integrado en el panel de ApliArte AI
- Selecciona archivos para adjuntarlos como contexto al chat
- El modelo "ve" tu código y responde con conocimiento de tu proyecto

### Acciones rápidas

Selecciona código y ejecuta con un click (o desde el menú contextual del editor):

| Acción | Descripción |
|--------|-------------|
| Explicar | Explicación detallada del código seleccionado |
| Refactorizar | Sugiere mejoras y código más limpio |
| Buscar bugs | Analiza posibles errores y edge cases |
| Generar tests | Crea tests unitarios para el código |
| Documentar | Genera documentación y comentarios |
| Optimizar | Propone mejoras de rendimiento |

### Recomendador de modelos

- Detecta tu hardware (RAM, CPU, GPU) automáticamente
- Sugiere el mejor modelo según tus recursos
- Recomendaciones separadas para LM Studio y Ollama

---

## Instalación

### Desde el Marketplace

1. Abre VS Code
2. `Cmd + Shift + X` (extensiones)
3. Busca **"ApliArte AI"**
4. Click en **Instalar**

### Desde la línea de comandos

```bash
code --install-extension apliarte.apliarte-ai
```

---

## Uso rápido

### Modo Local (sin instalar nada)

1. Abre el panel de **ApliArte AI** en la barra lateral
2. Selecciona **"Local (sin instalar nada)"** en el selector de proveedor
3. Elige la carpeta donde guardar los modelos (o usa la carpeta interna de la extensión)
4. La primera vez, se instalan las dependencias (~1 GB, automático)
5. Elige un modelo del catálogo o busca uno en HF Hub, y espera a que se descargue
6. Empieza a chatear

### Modo Remoto (LM Studio / Ollama)

1. Ten [LM Studio](https://lmstudio.ai/) u [Ollama](https://ollama.ai/) corriendo con un modelo cargado
2. Selecciona **"LM Studio / Ollama"** en el selector de proveedor
3. El modelo se detecta automáticamente
4. Empieza a chatear

### Modo Agent (tu propio servidor)

1. Despliega el backend en un VPS siguiendo la [guía de deployment](server/README.md)
2. Selecciona **"Agent (Cloud)"** en el selector de proveedor
3. Configura la URL y API key en los settings de VS Code:
   - `apliarteAi.agentEndpoint` → la URL de tu servidor (ej: `https://agent.tudominio.com`)
   - `apliarteAi.agentApiKey` → tu clave de API
4. El indicador mostrará **"Agent"** cuando esté conectado
5. (Opcional) Ejecuta el comando **"Indexar workspace (RAG)"** desde la paleta de comandos para que el agente conozca tu proyecto

### Atajos de teclado

| Atajo | Acción |
|-------|--------|
| `Cmd + Shift + G` | Enviar selección al chat |
| `Cmd + Shift + E` | Explicar código seleccionado |

### Paleta de comandos

Abre la paleta (`Cmd + Shift + P`) y escribe **"ApliArte AI"** para ver todos los comandos disponibles.

---

## Configuración

| Setting | Descripción | Default |
|---------|-------------|---------|
| `apliarteAi.preset` | Preset de configuración (minimal, ecosystem-only, full-gentleman) | `minimal` |
| `apliarteAi.modelsDir` | Carpeta para todos los modelos locales. Vacío = carpeta interna de la extensión | _(vacío)_ |
| `apliarteAi.lmstudioEndpoint` | URL del servidor LM Studio | `http://localhost:1234/v1` |
| `apliarteAi.ollamaEndpoint` | URL del servidor Ollama | `http://localhost:11434` |
| `apliarteAi.language` | Idioma del agente (es / en) | `es` |
| `apliarteAi.agentEndpoint` | URL del backend Agent (modo Agent) | _(vacío)_ |
| `apliarteAi.agentApiKey` | API key para autenticar con el backend Agent | _(vacío)_ |
| `apliarteAi.mcpServers` | Servidores MCP conectados (ver sección MCP) | `{}` |

---

## Arquitectura

```
apliarte-ai/
├── src/
│   ├── extension.ts              # Entry point, comandos, providers, RAG auto-index
│   ├── core/
│   │   ├── llmService.ts         # Cliente OpenAI-compatible con tool-calling (Remote)
│   │   ├── agentService.ts       # Cliente del backend Agent (SSE streaming)
│   │   ├── localInference.ts     # Inferencia local con transformers.js v4
│   │   ├── conversationStore.ts  # Persistencia multi-conversación (globalState)
│   │   ├── detector.ts           # Detección de LM Studio/Ollama
│   │   ├── preset.ts             # System prompts preconfigurados
│   │   └── modelRecommender.ts   # Recomendador de modelos según hardware
│   ├── mcp/
│   │   ├── serverManager.ts      # Gestor de ciclo de vida multi-server MCP
│   │   ├── toolRegistry.ts       # Registry unificado builtin + MCP tools
│   │   ├── transport-stdio.ts    # Transporte MCP stdio (spawn local)
│   │   ├── transport-http.ts     # Transporte MCP HTTP Streamable
│   │   ├── resourceRegistry.ts   # MCP Resources + Prompts
│   │   ├── jsonrpc.ts            # Cliente JSON-RPC 2.0
│   │   └── types.ts              # Tipos compartidos MCP
│   ├── tools/
│   │   └── executor.ts           # Ejecutor local (read/write/search/terminal)
│   ├── ui/
│   │   ├── chatView.ts           # Webview: chat, sidebar, settings, HF browser
│   │   ├── workspaceView.ts      # Explorador de workspace
│   │   └── quickActions.ts       # Acciones rápidas sobre código
│   └── utils/
│       └── logger.ts
├── server/                       # Backend para modo Agent (Docker + FastAPI)
├── dist/                         # Bundle compilado (esbuild)
├── package.json
└── esbuild.js
```

### Stack técnico

- **TypeScript** + **esbuild** (bundle de ~150 KB)
- **transformers.js v4** para inferencia local (instalado on-demand)
- **MCP JSON-RPC 2.0** cliente propio (stdio + HTTP Streamable HTTP)
- **API OpenAI-compatible** con tool-calling para LM Studio/Ollama
- **FastAPI** + embeddings para el backend Agent
- **VS Code Webview API** para la interfaz del chat

---

## Privacidad

ApliArte AI respeta tu privacidad por diseño:

- **Modo Local**: El modelo corre dentro del proceso de VS Code usando transformers.js. Nada sale de tu máquina.
- **Modo Remoto**: La comunicación es entre VS Code y tu servidor local (localhost). Nada sale de tu red.
- **Modo Agent**: Tu código se envía a **tu propio servidor** (que tú controlas). Las herramientas (leer/escribir archivos, terminal) se ejecutan **localmente** en tu máquina — el servidor solo coordina con el modelo de IA. Este modo es **opt-in**: solo se activa si tú lo configuras.
- **Sin telemetría**: No se recopila ningún dato de uso.
- **Sin cuentas**: No se requiere registro ni login.

---

## Roadmap

- [x] v0.1 — Detección de LM Studio/Ollama
- [x] v0.2 — Chat con streaming y markdown
- [x] v0.3 — Workspace explorer, acciones rápidas, diff/apply, recomendador de modelos
- [x] v0.4 — Inferencia local con transformers.js v4
- [x] v0.5 — Modo Agent con backend propio (tool-calling, RAG, deploy en VPS)
- [x] v0.6 — Persistencia multi-conversación, settings inline, Engram MCP
- [x] v0.7 — MCP Client genérico (stdio + HTTP), tool-calling Remote, ToolRegistry unificado
- [x] **v0.8 — HF Hub browser, gestión de carpeta de modelos, MCP Resources/Prompts, i18n EN/ES, RAG auto-index**
- [x] **v0.9 — Monitor t/s, ripgrep en Agent, alternativas de código, scan mejorado de modelos**
- [ ] v1.0 — GGUF nativo, Jan como proveedor, templates MCP por stack, release estable

> 📋 Roadmap técnico detallado: [ROADMAP.md](ROADMAP.md)

---

## Compatibilidad

- VS Code >= 1.93.0
- Cursor AI
- Windsurf IDE
- Antigravity
- VS Codium
- Windows / macOS / Linux

---

## Contribuir

Las contribuciones son bienvenidas. Abre un [issue](https://github.com/erbolamm/apliarte-ai/issues) o un [pull request](https://github.com/erbolamm/apliarte-ai/pulls).

```bash
git clone https://github.com/erbolamm/apliarte-ai.git
cd apliarte-ai
npm install
npm run watch   # Desarrollo con hot-reload
# F5 en VS Code para lanzar la Extension Development Host
```

---

## Autor

Javier Mateo (ApliArte) — [github.com/erbolamm](https://github.com/erbolamm)

## 💬 Una nota personal del autor / A personal note from the author

> ℹ️ Nota: El texto siguiente es un mensaje personal del autor, escrito en varios idiomas para que pueda leerlo gente de todo el mundo. Esto no implica que el proyecto tenga soporte funcional completo en esos idiomas.

> ℹ️ Note: The text below is a personal message from the author, written in several languages so people around the world can read it. This does not imply full multilingual feature support in those languages.

<details>
<summary>🇪🇸 Español</summary>

ApliArte AI nació de una frustración: todas las extensiones de IA para VS Code te piden una API key de pago o envían tu código a servidores externos. Yo quería algo que funcionara en MI máquina, con MIS modelos, sin depender de nadie.

Con transformers.js v4 conseguí que los modelos corran directamente dentro de VS Code — sin instalar LM Studio, sin Ollama, sin nada. Un click y funciona. Tu código nunca sale de tu ordenador.

Si eres desarrollador y valoras tu privacidad, esta herramienta es para ti. Es gratis, es open source, y siempre lo será.

</details>

<details>
<summary>🇬🇧 English</summary>

ApliArte AI was born out of frustration: every AI extension for VS Code requires a paid API key or sends your code to external servers. I wanted something that runs on MY machine, with MY models, without depending on anyone.

With transformers.js v4, I made models run directly inside VS Code — no LM Studio, no Ollama, nothing to install. One click and it works. Your code never leaves your computer.

If you're a developer who values privacy, this tool is for you. It's free, it's open source, and it always will be.

</details>

<details>
<summary>🇧🇷 Português</summary>

ApliArte AI nasceu de uma frustração: todas as extensões de IA para VS Code pedem uma API key paga ou enviam seu código para servidores externos. Eu queria algo que rodasse na MINHA máquina, com MEUS modelos, sem depender de ninguém.

Com transformers.js v4, consegui que os modelos rodem diretamente dentro do VS Code — sem instalar LM Studio, sem Ollama, sem nada. Um clique e funciona. Seu código nunca sai do seu computador.

Se você é desenvolvedor e valoriza sua privacidade, essa ferramenta é para você. É grátis, é open source, e sempre será.

</details>

<details>
<summary>🇫🇷 Français</summary>

ApliArte AI est né d'une frustration : toutes les extensions IA pour VS Code demandent une clé API payante ou envoient votre code vers des serveurs externes. Je voulais quelque chose qui tourne sur MA machine, avec MES modèles, sans dépendre de personne.

Avec transformers.js v4, j'ai fait tourner les modèles directement dans VS Code — pas de LM Studio, pas d'Ollama, rien à installer. Un clic et ça marche. Votre code ne quitte jamais votre ordinateur.

Si vous êtes développeur et que vous tenez à votre vie privée, cet outil est pour vous. C'est gratuit, c'est open source, et ça le restera toujours.

</details>

<details>
<summary>🇩🇪 Deutsch</summary>

ApliArte AI entstand aus Frustration: Jede KI-Erweiterung für VS Code verlangt einen kostenpflichtigen API-Schlüssel oder sendet Ihren Code an externe Server. Ich wollte etwas, das auf MEINEM Computer läuft, mit MEINEN Modellen, ohne von irgendjemandem abhängig zu sein.

Mit transformers.js v4 laufen die Modelle direkt in VS Code — kein LM Studio, kein Ollama, nichts zu installieren. Ein Klick und es funktioniert. Ihr Code verlässt niemals Ihren Computer.

Wenn Sie Entwickler sind und Ihre Privatsphäre schätzen, ist dieses Tool für Sie. Es ist kostenlos, es ist Open Source, und das wird es immer bleiben.

</details>

<details>
<summary>🇮🇹 Italiano</summary>

ApliArte AI è nato da una frustrazione: tutte le estensioni IA per VS Code richiedono una chiave API a pagamento o inviano il tuo codice a server esterni. Volevo qualcosa che funzionasse sulla MIA macchina, con i MIEI modelli, senza dipendere da nessuno.

Con transformers.js v4, ho fatto funzionare i modelli direttamente dentro VS Code — niente LM Studio, niente Ollama, niente da installare. Un click e funziona. Il tuo codice non lascia mai il tuo computer.

Se sei uno sviluppatore e tieni alla tua privacy, questo strumento è per te. È gratuito, è open source, e lo sarà sempre.

</details>

## � Comparte

Si te gusta ApliArte AI, ayuda a que más gente lo conozca:

[![Compartir en Twitter](https://img.shields.io/badge/Twitter-Compartir-1DA1F2?logo=twitter&logoColor=white)](https://twitter.com/intent/tweet?text=Chat%20de%20IA%20100%25%20local%20para%20VS%20Code.%20Sin%20APIs%2C%20sin%20cuentas%2C%20gratis.&url=https%3A%2F%2Ferbolamm.github.io%2Fapliarte-ai%2F&via=erbolamm)
[![Compartir en LinkedIn](https://img.shields.io/badge/LinkedIn-Compartir-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Ferbolamm.github.io%2Fapliarte-ai%2F)
[![Compartir en Reddit](https://img.shields.io/badge/Reddit-Compartir-FF4500?logo=reddit&logoColor=white)](https://www.reddit.com/submit?url=https%3A%2F%2Ferbolamm.github.io%2Fapliarte-ai%2F&title=ApliArte%20AI%20%E2%80%94%20Chat%20de%20IA%20100%25%20local%20para%20VS%20Code)
[![Compartir en WhatsApp](https://img.shields.io/badge/WhatsApp-Compartir-25D366?logo=whatsapp&logoColor=white)](https://api.whatsapp.com/send?text=ApliArte%20AI%20%E2%80%94%20Chat%20de%20IA%20100%25%20local%20para%20VS%20Code.%20https%3A%2F%2Ferbolamm.github.io%2Fapliarte-ai%2F)

## �💖 Apoya el proyecto

Herramienta gratuita y open source. Si te ahorra tiempo, un café ayuda a mantener el desarrollo.

| Plataforma | Enlace |
|-----------|--------|
| PayPal | [paypal.me/erbolamm](https://paypal.me/erbolamm) |
| Ko-fi | [ko-fi.com/C0C11TWR1K](https://ko-fi.com/C0C11TWR1K) |
| Twitch Tip | [streamelements.com/apliarte/tip](https://streamelements.com/apliarte/tip) |

🌐 [Sitio oficial](https://erbolamm.github.io/apliarte-ai/) · 📦 [GitHub](https://github.com/erbolamm/apliarte-ai)

## Licencia

MIT — © 2026 ApliArte
