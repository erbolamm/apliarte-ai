<p align="center">
  <img src="icon.png" alt="ApliArte AI" width="128" />
</p>

<h1 align="center">ApliArte AI</h1>

<p align="center">
  <strong>Chat de IA 100% local para VS Code.</strong><br>
  Corre modelos directamente en tu máquina — sin APIs externas, sin cuentas, sin coste.<br>
  También conecta LM Studio y Ollama si ya los usás.
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

---

## Por qué ApliArte AI

La mayoría de extensiones de IA para VS Code requieren una API key de pago o envían tu código a la nube. ApliArte AI es diferente:

- **Sin internet**: Todo corre en tu máquina. Tu código nunca sale de tu ordenador.
- **Sin cuentas**: No necesitás registrarte en ningún servicio.
- **Sin coste**: Modelos open-source, gratis para siempre.
- **Dos modos**: Inferencia local directa (transformers.js v4) o conectar LM Studio/Ollama.

---

## Funcionalidades

### Chat con IA local

- Streaming en tiempo real con respuestas en markdown
- Bloques de código con syntax highlighting
- Botones de **copiar**, **insertar en editor** y **aplicar diff** en cada bloque
- Historial de conversación con export a markdown
- Control de temperatura para ajustar creatividad

### Inferencia local (modo Local)

- Corre modelos ONNX directamente en VS Code usando [transformers.js v4](https://github.com/huggingface/transformers.js)
- No necesitás instalar nada externo — las dependencias se descargan automáticamente la primera vez
- Catálogo de modelos preconfigurados y verificados:

| Modelo | Tamaño | Uso recomendado |
|--------|--------|-----------------|
| Qwen 2.5 0.5B | ~350 MB | Ultra-rápido, respuestas instantáneas |
| Qwen 2.5 1.5B | ~1 GB | Buen balance velocidad/calidad |
| Qwen 2.5 3B | ~2 GB | Mejor calidad de respuestas |
| SmolLM2 360M | ~250 MB | Mínimo consumo de recursos |

- Barra de progreso durante la descarga del modelo
- Los modelos se cachean localmente después de la primera descarga

### Conexión con LM Studio / Ollama (modo Remoto)

- Detección automática de LM Studio y Ollama
- Selector de modelo entre los cargados en tu servidor local
- Indicador de conexión con reintento automático
- Compatible con cualquier modelo que soporte la API de OpenAI

### Explorador de workspace

- Árbol de archivos integrado en el panel de ApliArte AI
- Seleccioná archivos para adjuntarlos como contexto al chat
- El modelo "ve" tu código y responde con conocimiento de tu proyecto

### Acciones rápidas

Seleccioná código y ejecutá con un click (o desde el menú contextual del editor):

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

1. Abrí VS Code
2. `Cmd + Shift + X` (extensiones)
3. Buscá **"ApliArte AI"**
4. Click en **Instalar**

### Desde la línea de comandos

```bash
code --install-extension apliarte.apliarte-ai
```

---

## Uso rápido

### Modo Local (sin instalar nada)

1. Abrí el panel de **ApliArte AI** en la barra lateral
2. Seleccioná **"Local (sin instalar nada)"** en el selector de proveedor
3. La primera vez, se instalan las dependencias (~1 GB, automático)
4. Elegí un modelo del catálogo y esperá a que se descargue
5. Empezá a chatear

### Modo Remoto (LM Studio / Ollama)

1. Tené [LM Studio](https://lmstudio.ai/) u [Ollama](https://ollama.ai/) corriendo con un modelo cargado
2. Seleccioná **"LM Studio / Ollama"** en el selector de proveedor
3. El modelo se detecta automáticamente
4. Empezá a chatear

### Atajos de teclado

| Atajo | Acción |
|-------|--------|
| `Cmd + Shift + G` | Enviar selección al chat |
| `Cmd + Shift + E` | Explicar código seleccionado |

### Paleta de comandos

Abrí la paleta (`Cmd + Shift + P`) y escribí **"ApliArte AI"** para ver todos los comandos disponibles.

---

## Configuración

| Setting | Descripción | Default |
|---------|-------------|---------|
| `apliarteAi.lmstudioEndpoint` | URL del servidor LM Studio/Ollama | `http://localhost:1234/v1` |
| `apliarteAi.systemPrompt` | Prompt de sistema personalizado | (preset Gentleman) |
| `apliarteAi.temperature` | Temperatura del modelo (0.0 - 2.0) | `0.7` |

---

## Arquitectura

```
apliarte-ai/
├── src/
│   ├── extension.ts          # Entry point, registra comandos y providers
│   ├── core/
│   │   ├── llmService.ts     # Cliente OpenAI-compatible (LM Studio/Ollama)
│   │   ├── localInference.ts # Inferencia local con transformers.js v4
│   │   ├── detector.ts       # Detección de LM Studio/Ollama en el sistema
│   │   ├── setup.ts          # Wizard de configuración inicial
│   │   ├── preset.ts         # System prompts preconfigurados
│   │   └── modelRecommender.ts # Recomendador de modelos según hardware
│   ├── ui/
│   │   ├── chatView.ts       # Webview del chat principal
│   │   ├── workspaceView.ts  # Explorador de workspace
│   │   └── quickActions.ts   # Acciones rápidas sobre código
│   └── utils/
│       └── logger.ts         # Sistema de logs
├── dist/                     # Bundle compilado (esbuild)
├── package.json              # Manifiesto de la extensión
└── esbuild.js                # Configuración de build
```

### Stack técnico

- **TypeScript** + **esbuild** (bundle de ~70 KB)
- **transformers.js v4** para inferencia local (instalado on-demand, no en el bundle)
- **API OpenAI-compatible** para LM Studio/Ollama
- **VS Code Webview API** para la interfaz del chat

---

## Privacidad

ApliArte AI no envía datos a ningún servidor externo. Todo el procesamiento ocurre en tu máquina:

- **Modo Local**: El modelo corre dentro del proceso de VS Code usando transformers.js
- **Modo Remoto**: La comunicación es entre VS Code y tu servidor local (localhost)
- **Sin telemetría**: No se recopila ningún dato de uso
- **Sin cuentas**: No se requiere registro ni login

---

## Roadmap

- [x] v0.1 — Detección de LM Studio/Ollama
- [x] v0.2 — Chat con streaming y markdown
- [x] v0.3 — Workspace explorer, acciones rápidas, diff/apply, recomendador de modelos
- [x] v0.4 — Inferencia local con transformers.js v4
- [ ] v0.5 — Soporte MCP (Model Context Protocol)
- [ ] v0.6 — Multi-idioma (EN/ES)
- [ ] v1.0 — Agentes autónomos locales

---

## Contribuir

Las contribuciones son bienvenidas. Abrí un [issue](https://github.com/erbolamm/apliarte-ai/issues) o un [pull request](https://github.com/erbolamm/apliarte-ai/pulls).

```bash
git clone https://github.com/erbolamm/apliarte-ai.git
cd apliarte-ai
npm install
npm run watch   # Desarrollo con hot-reload
# F5 en VS Code para lanzar la Extension Development Host
```

---

## Autor

**Javier Mateo (ApliArte)** — [github.com/erbolamm](https://github.com/erbolamm)

## Licencia

[MIT](LICENSE)
