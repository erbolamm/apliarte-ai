# Cliente MCP — ApliArte AI

ApliArte AI implementa un cliente [Model Context Protocol](https://modelcontextprotocol.io) completo. Puedes conectar cualquier servidor MCP y sus herramientas quedan disponibles para el LLM automáticamente.

---

## ¿Qué es MCP?

MCP es un protocolo abierto que permite a los LLMs usar herramientas externas de forma estandarizada: leer archivos, consultar bases de datos, buscar en GitHub, navegar por el web, etc. Cada servidor MCP expone un conjunto de herramientas. El LLM decide cuándo llamarlas.

---

## Configuración

Edita `apliarteAi.mcpServers` en VS Code Settings (`Cmd+,` → busca `apliarteAi.mcpServers`).

### Transporte stdio

El servidor MCP se ejecuta como proceso hijo. Requiere Node.js.

```json
{
  "apliarteAi.mcpServers": {
    "memory": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/tu-usuario/proyectos"]
    }
  }
}
```

### Transporte HTTP

El servidor MCP ya está corriendo como servicio HTTP (MCP Streamable HTTP).

```json
{
  "apliarteAi.mcpServers": {
    "mi-servidor": {
      "transport": "http",
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer mi-token"
      }
    }
  }
}
```

### Variables de entorno y directorio de trabajo

```json
{
  "apliarteAi.mcpServers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_tu_token_aqui"
      }
    },
    "postgres": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "POSTGRES_CONNECTION_STRING": "postgresql://user:pass@localhost/mi_db"
      }
    }
  }
}
```

---

## Servidores verificados

| Servidor | Paquete npm | Herramientas |
|----------|-------------|--------------|
| Memoria persistente | `@modelcontextprotocol/server-memory` | `create_entities`, `search_nodes`, `read_graph` |
| Filesystem | `@modelcontextprotocol/server-filesystem` | `read_file`, `write_file`, `list_directory`, `search_files` |
| GitHub | `@modelcontextprotocol/server-github` | `search_repositories`, `get_file_contents`, `create_issue`, `create_pull_request` |
| PostgreSQL | `@modelcontextprotocol/server-postgres` | `query`, `list_tables`, `describe_table` |
| SQLite | `@modelcontextprotocol/server-sqlite` | `read_query`, `write_query`, `list_tables` |
| Browser (Playwright) | `@playwright/mcp` | `navigate`, `click`, `screenshot`, `fill` |

---

## Quick-setup desde la UI

En el panel de Configuración (⚙️ dentro del chat) hay botones de instalación con un click para los servidores más comunes.

También puedes aplicar una **plantilla de stack** que configura varios servidores de una sola vez:

| Stack | Servidores |
|-------|-----------|
| Node.js / TypeScript | memory + filesystem + github |
| Python | memory + filesystem + postgres |
| Go | memory + filesystem + github |
| Full-stack web | memory + filesystem + github + playwright |

---

## Estado y reconexión

- Los badges de colores en la toolbar muestran el estado de cada servidor en tiempo real.
- Verde = conectado · Naranja = error · Gris = desconectado
- Comando `ApliArte AI: Estado de servidores MCP` para ver el detalle del error.
- Comando `ApliArte AI: Reiniciar servidor MCP` para reconectar un servidor específico.

---

## Crea tu propio servidor MCP

### TypeScript (stdio)

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  { name: 'mi-servidor', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'saludo',
    description: 'Saluda al usuario',
    inputSchema: {
      type: 'object',
      properties: { nombre: { type: 'string' } },
      required: ['nombre'],
    },
  }],
}));

server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name === 'saludo') {
    const nombre = (request.params.arguments as { nombre: string }).nombre;
    return { content: [{ type: 'text', text: `¡Hola, ${nombre}!` }] };
  }
  throw new Error(`Herramienta desconocida: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Python (stdio)

```python
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

server = Server("mi-servidor")

@server.list_tools()
async def list_tools():
    return [
        Tool(
            name="saludo",
            description="Saluda al usuario",
            inputSchema={
                "type": "object",
                "properties": {"nombre": {"type": "string"}},
                "required": ["nombre"],
            },
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "saludo":
        return [TextContent(type="text", text=f"¡Hola, {arguments['nombre']}!")]
    raise ValueError(f"Herramienta desconocida: {name}")

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

import asyncio
asyncio.run(main())
```

Instala con: `pip install mcp`

### Registro en ApliArte AI

```json
{
  "apliarteAi.mcpServers": {
    "mi-servidor": {
      "transport": "stdio",
      "command": "node",
      "args": ["/ruta/a/mi-servidor/dist/index.js"]
    }
  }
}
```

---

## Notas de compatibilidad

- **Modo Local** (transformers.js): los modelos pequeños generalmente no soportan tool-calling. Las herramientas MCP no están disponibles — verás una nota informativa en el chat.
- **Modo Remote** (LM Studio / Ollama / Jan): tool-calling disponible si el modelo lo soporta. Loop de hasta 10 iteraciones tool→respuesta.
- **Modo Agent**: tool-calling disponible. Las herramientas MCP se ejecutan siempre en la máquina del usuario, nunca en el servidor remoto.
