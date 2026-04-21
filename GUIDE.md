# Guía de usuario — ApliArte AI

> Esta guía explica TODO lo que puedes hacer con la extensión, paso a paso, sin asumir conocimientos previos.

---

## ¿Qué es ApliArte AI?

Es una extensión de VS Code que te permite chatear con modelos de IA directamente desde el editor. **Sin pagar APIs, sin mandar tu código a la nube** (a menos que tú lo elijas).

Tienes tres formas de usarla:

| Modo | ¿Qué necesitas? | ¿Es gratis? | ¿Es privado? |
|------|-----------------|-------------|--------------|
| **Local** | Nada extra | ✅ 100% | ✅ 100% |
| **Remote** | LM Studio u Ollama corriendo | ✅ 100% | ✅ 100% |
| **Agent** | Una API key del backend ApliArte | ❌ de pago | depende del modelo |

---

## Instalación

1. Abre VS Code
2. Ir a la pestaña de extensiones (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Buscar **ApliArte AI**
4. Click en **Instalar**
5. Aparece el ícono de ApliArte en la barra lateral izquierda — clickealo para abrir el chat

---

## Modo Local — IA que corre en tu máquina sin nada más

El modelo de IA corre **dentro de VS Code** usando tu CPU/GPU. No necesitas LM Studio ni Ollama ni nada extra.

### Cómo activarlo

1. Abre el chat (ícono de ApliArte en la barra lateral)
2. En el panel de configuración (ícono de engranaje ⚙️ dentro del chat), elige **modo Local**
3. La primera vez que mandés un mensaje, la extensión descarga automáticamente el modelo recomendado (~600 MB)
4. Espera la barra de progreso — después de eso, todo funciona offline

### ¿Qué modelos usa?

Por defecto usa **Qwen2.5-Coder-0.5B** (modelo pequeño, optimizado para código). Puedes cambiarlo desde el panel de configuración.

> **Limitación**: Los modelos locales son pequeños. Sirven para tareas concretas (explicar una función, corregir un bug). Para conversaciones largas o proyectos complejos, usa modo Remote o Agent.

---

## Modo Remote — LM Studio u Ollama en tu máquina

Usas un modelo más grande que ya tienes en LM Studio u Ollama. La extensión se conecta a ellos localmente — **tu código no sale de tu máquina**.

### Con LM Studio

1. Descarga e instala [LM Studio](https://lmstudio.ai)
2. Descarga cualquier modelo (recomendado: Qwen2.5-Coder-7B, Llama 3.1, Mistral)
3. En LM Studio, haz click en **Local Server** (panel izquierdo) → **Start Server**
4. En ApliArte AI → configuración ⚙️ → modo **Remote** → URL: `http://localhost:1234/v1`
5. Listo. El modelo que tengas cargado en LM Studio aparece automáticamente

### Con Ollama

1. Instala [Ollama](https://ollama.ai)
2. En la terminal: `ollama pull llama3.1` (o el modelo que quieras)
3. Ollama arranca solo al instalarse — en ApliArte → configuración ⚙️ → modo **Remote** → URL: `http://localhost:11434`
4. Listo

### ¿Qué modelos funcionan mejor?

Para programación: `qwen2.5-coder:7b`, `deepseek-coder-v2`, `codestral`  
Para uso general: `llama3.1:8b`, `mistral:7b`, `gemma2:9b`

---

## Modo Agent — IA con acceso a tu proyecto

El modo Agent conecta con un backend en la nube que le da a la IA acceso a tus archivos, búsqueda de código, ejecución de comandos, y herramientas MCP.

### Cómo activarlo

1. Necesitas endpoint + API key del backend ApliArte
2. En configuración ⚙️ → modo **Agent**
3. Completá `Agent Endpoint` y `Agent API Key`

> Las herramientas (leer archivos, buscar código, etc.) se ejecutan **en tu máquina**, nunca en el servidor. El backend solo coordina el LLM.

---

## Adjuntar archivos al chat

Hay varias formas de darle contexto a la IA:

### Archivo completo
- Click derecho en cualquier archivo → **ApliArte AI → Enviar archivo al chat**
- O: `Cmd+Shift+G` con el cursor en el archivo

### Selección de código
1. Selecciona el código en el editor
2. Click derecho → **ApliArte AI → Enviar selección al chat**
3. O: `Cmd+Shift+G` con texto seleccionado

### Múltiples archivos (Workspace Explorer)
1. En la barra lateral de ApliArte hay una vista **Workspace**
2. Marcá los archivos con el checkbox
3. Click en el ícono de enviar (esquina superior del panel)

---

## Acciones rápidas

Con código seleccionado, click derecho → **ApliArte AI** → elige la acción:

| Acción | Atajo | Qué hace |
|--------|-------|----------|
| Explicar código | `Cmd+Shift+E` | Explica qué hace el código seleccionado |
| Refactorizar | — | Propone una versión mejorada |
| Buscar bugs | — | Analiza el código buscando errores |
| Generar tests | — | Crea tests para el código seleccionado |
| Documentar | — | Agrega JSDoc / docstrings |
| Optimizar | — | Propone mejoras de performance |

---

## Conversaciones — guardar y retomar

ApliArte AI guarda tus conversaciones automáticamente. Nunca perdés el historial.

### Crear / cambiar conversación
- Click en **Nueva conversación** (ícono `+` arriba del chat)
- O haz click en cualquier conversación anterior en el sidebar

### Renombrar
- Doble click sobre el nombre de la conversación en el sidebar
- Escribe el nuevo nombre → Enter

### Exportar
- Click derecho sobre una conversación → **Exportar** → guarda como Markdown

---

## MCP — Conectar herramientas externas

MCP (Model Context Protocol) permite conectar herramientas externas que el LLM puede usar durante la conversación. Por ejemplo: memoria persistente, acceso a GitHub, bases de datos, filesystem avanzado.

> **En términos simples**: es como darle superpoderes extra a la IA. Tú configuras qué herramientas tiene disponibles.

### Cómo configurar un servidor MCP

Abre la configuración de VS Code (`Cmd+,`) y busca `apliarteAi.mcpServers`.

Hay dos tipos de servidores:

#### Tipo `http` — servidor que ya está corriendo

```json
"apliarteAi.mcpServers": {
  "nombre-del-servidor": {
    "transport": "http",
    "url": "http://localhost:4200"
  }
}
```

#### Tipo `stdio` — programa que la extensión arranca

```json
"apliarteAi.mcpServers": {
  "nombre-del-servidor": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/ruta/a/tu/carpeta"]
  }
}
```

### Ejemplos reales

#### Engram (memoria persistente cross-session)

Primero levantá el servidor Engram en tu máquina (ver su documentación). Luego:

```json
"apliarteAi.mcpServers": {
  "engram": {
    "transport": "http",
    "url": "http://localhost:4200"
  }
}
```

Una vez conectado, el LLM puede guardar y recuperar recuerdos de conversaciones anteriores usando herramientas como `mem_save` y `mem_search` de forma automática.

#### Filesystem — que la IA lea/escriba archivos

```json
"apliarteAi.mcpServers": {
  "filesystem": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"]
  }
}
```

> Requiere Node.js instalado. La IA solo accede a la carpeta que especificás.

#### GitHub — issues, PRs, repos

```json
"apliarteAi.mcpServers": {
  "github": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "tu-token-aquí"
    }
  }
}
```

#### Múltiples servidores a la vez

```json
"apliarteAi.mcpServers": {
  "engram": {
    "transport": "http",
    "url": "http://localhost:4200"
  },
  "filesystem": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"]
  }
}
```

### Ver el estado de los servidores

- Comando: `ApliArte AI: Estado de servidores MCP` (palette de comandos `Cmd+Shift+P`)
- O mira los badges de colores en la toolbar del chat:
  - 🟢 Verde = conectado y listo
  - 🟡 Amarillo = conectando...
  - 🔴 Rojo = error
  - ⚪ Gris = detenido

### Servidores verificados

| Servidor | Paquete npm | Para qué sirve |
|----------|-------------|---------------|
| Memoria | `@modelcontextprotocol/server-memory` | Contexto persistente entre sesiones |
| Filesystem | `@modelcontextprotocol/server-filesystem` | Leer y escribir archivos fuera del workspace |
| GitHub | `@modelcontextprotocol/server-github` | Issues, PRs, búsqueda de código |
| PostgreSQL | `@modelcontextprotocol/server-postgres` | Consultas SQL |
| SQLite | `@modelcontextprotocol/server-sqlite` | Bases de datos locales `.sqlite` |
| Browser | `@playwright/mcp` | Navegar webs, screenshots |

Documentación completa: [docs/mcp.md](docs/mcp.md)

### Reiniciar un servidor que falla

Comando: `ApliArte AI: Reiniciar servidor MCP` → elige cuál.

---

## Tool-calling — cómo la IA usa las herramientas

Cuando la IA decide usar una herramienta, lo verás en el chat:

```
**Ejecutando filesystem.read_file**...
```

Seguido del resultado (primeros 200 caracteres). La IA puede encadenar varias herramientas antes de darte la respuesta final.

> **Modo Local**: los modelos pequeños generalmente no soportan tool-calling. Si tienes servidores MCP configurados, verás una nota avisándote.

---

## Presets — ajustar el sistema según el modelo

El preset controla cuánto contexto del sistema se le envía al modelo:

| Preset | Tokens | Cuándo usarlo |
|--------|--------|---------------|
| **Minimal** | ~5k | Modelos ≤ 8B (modo Local, modelos pequeños) |
| **Ecosystem-only** | ~20k | Modelos 13B–30B |
| **Full Gentleman** | ~49k | Modelos grandes o APIs en la nube |

Cambiar preset: `ApliArte AI: Cambiar Preset` desde la palette de comandos.

---

## Migración desde versiones anteriores

### Vengo de v0.6.x con Engram configurado en `apliarteAi.engramEndpoint`

No hace falta hacer nada. La extensión detecta automáticamente esa configuración y la migra como un servidor MCP llamado `engram`. Funciona igual que antes.

### ¿Dónde fue el panel de memorias de Engram?

En v0.7 se eliminó el panel específico de Engram. Ahora la IA interactúa con Engram directamente a través de tool-calling — cuando necesita guardar o buscar un recuerdo, lo hace sola. Verás el badge `engram` en la toolbar del chat cuando el servidor está conectado.

---

## Atajos de teclado

| Acción | Mac | Windows/Linux |
|--------|-----|---------------|
| Enviar selección al chat | `Cmd+Shift+G` | `Ctrl+Shift+G` |
| Explicar código seleccionado | `Cmd+Shift+E` | `Ctrl+Shift+E` |

---

## Solución de problemas frecuentes

### "No hay modelo cargado"
- **Modo Remote**: Asegurate de que LM Studio u Ollama esté corriendo y tenga un modelo cargado.
- **Modo Local**: La primera vez tarda en descargar el modelo (~600 MB). Espera a que la barra de progreso termine.

### El servidor MCP aparece en rojo (error)
1. Abre la palette de comandos → `ApliArte AI: Estado de servidores MCP` para ver el detalle del error
2. Verifica que el servidor esté corriendo (para HTTP) o que el comando sea válido (para stdio)
3. Usa `ApliArte AI: Reiniciar servidor MCP` para intentar reconectar

### El modelo no responde / se queda cargando
- Hay un timeout de 60 segundos para la respuesta y 30 segundos por herramienta
- Si el modelo es muy lento, puedes subir el timeout en la configuración (próxima versión)
- Prueba con un modelo más pequeño

### No aparecen los badges MCP en el chat
- Los badges aparecen cuando hay al menos un servidor configurado en `apliarteAi.mcpServers`
- Si acabás de agregar la configuración, cierra y vuelve a abrir el panel del chat

### La IA no usa las herramientas MCP
- En modo Remote: el modelo debe soportar function calling (Llama 3.1+, Qwen2.5, Mistral Nemo+)
- En modo Local: los modelos pequeños no soportan tool-calling (es una limitación del modelo, no de la extensión)
- En modo Agent: el backend maneja esto automáticamente

---

## Privacidad

| ¿Qué pasa con mi código? | Modo Local | Modo Remote | Modo Agent |
|--------------------------|-----------|-------------|------------|
| Sale de mi máquina | ❌ Nunca | ❌ Nunca | ✅ Va al backend |
| Lo ven terceros | ❌ | ❌ | Según el modelo |
| Necesita internet | Solo 1ª vez (descarga) | ❌ | ✅ |

---

## Feedback y reportar bugs

Reportá problemas en: [github.com/erbolamm/apliarte-ai/issues](https://github.com/erbolamm/apliarte-ai/issues)
