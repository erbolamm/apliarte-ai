# 🚀 ApliArte AI — Guía de Deployment del Servidor Agent

Esta guía te explica **paso a paso** cómo montar tu propio servidor para el modo Agent de ApliArte AI. Al terminar, tendrás un backend propio que conecta la extensión de VS Code con modelos de IA potentes (OpenAI, Anthropic, Google, Groq…).

> **¿No tienes VPS?** Puedes contratar uno en [Hostinger](https://www.hostinger.com/es?REFERRALCODE=APLIARTE) desde ~5€/mes. Con el plan KVM 2 (2 CPU, 8 GB RAM, 100 GB) sobra para este servidor.

---

## Índice

1. [Requisitos previos](#requisitos-previos)
2. [Paso 1 — Contratar un VPS](#paso-1--contratar-un-vps)
3. [Paso 2 — Conectarte al servidor por SSH](#paso-2--conectarte-al-servidor-por-ssh)
4. [Paso 3 — Instalar Docker (si no lo tienes)](#paso-3--instalar-docker-si-no-lo-tienes)
5. [Paso 4 — Subir los archivos del servidor](#paso-4--subir-los-archivos-del-servidor)
6. [Paso 5 — Configurar las variables de entorno](#paso-5--configurar-las-variables-de-entorno)
7. [Paso 6 — Levantar los servicios](#paso-6--levantar-los-servicios)
8. [Paso 7 — Verificar que funciona](#paso-7--verificar-que-funciona)
9. [Paso 8 — Configurar un dominio (opcional pero recomendado)](#paso-8--configurar-un-dominio-opcional-pero-recomendado)
10. [Paso 9 — Conectar la extensión](#paso-9--conectar-la-extensión)
11. [Solución de problemas](#solución-de-problemas)
12. [Arquitectura del servidor](#arquitectura-del-servidor)

---

## Requisitos previos

- Un **VPS con Linux** (Ubuntu 22.04/24.04 recomendado)
- Mínimo **2 GB de RAM** (recomendado 4 GB+)
- **Docker** y **Docker Compose** instalados
- Un **AI Gateway** o acceso directo a APIs de LLM (OpenAI, Groq, etc.)
- **Ollama** instalado en el servidor (para generar embeddings de RAG)

> 💡 **¿Qué es un AI Gateway?** Es un proxy que te permite usar múltiples proveedores de IA (OpenAI, Anthropic, Google, Groq, DeepSeek…) desde una sola URL. Puedes usar [LiteLLM](https://github.com/BerriAI/litellm), [AI Gateway de Portkey](https://github.com/Portkey-ai/gateway), o directamente la URL de OpenAI (`https://api.openai.com/v1/chat/completions`).

---

## Paso 1 — Contratar un VPS

Si no tienes un servidor, necesitas uno. Recomiendo [Hostinger VPS](https://www.hostinger.com/es?REFERRALCODE=APLIARTE) porque:

- Los planes son económicos (~5-10€/mes)
- Incluyen Ubuntu con Docker preinstalado
- Tienen panel de control fácil de usar
- IP fija incluida

### Qué plan elegir

| Plan | RAM | CPU | Disco | ¿Suficiente? |
|------|-----|-----|-------|---------------|
| KVM 1 | 4 GB | 1 | 50 GB | ✅ Mínimo para el servidor Agent |
| **KVM 2** | **8 GB** | **2** | **100 GB** | ✅ **Recomendado** — cabe Ollama + embeddings + servidor |
| KVM 4 | 16 GB | 4 | 200 GB | ✅ Si quieres correr modelos locales con Ollama |

1. Ve a [hostinger.com/es](https://www.hostinger.com/es?REFERRALCODE=APLIARTE)
2. Elige **VPS Hosting**
3. Selecciona el plan **KVM 2** (o superior)
4. En sistema operativo elige **Ubuntu 24.04 with Docker**
5. Anota la **IP** y la **contraseña de root** que te dan

---

## Paso 2 — Conectarte al servidor por SSH

Abre una terminal en tu ordenador y escribe:

```bash
ssh root@TU_IP_DEL_VPS
```

Reemplaza `TU_IP_DEL_VPS` por la IP que te dio Hostinger (ej: `ssh root@72.60.187.93`).

La primera vez te preguntará si confías en el servidor — escribe `yes` y pulsa Enter.

Te pedirá la contraseña — es la que pusiste al contratar el VPS.

### ¿Usar clave SSH en vez de contraseña? (recomendado)

Es más seguro. Desde tu ordenador:

```bash
# Generar una clave SSH (si no tienes una)
ssh-keygen -t ed25519

# Copiarla al servidor
ssh-copy-id root@TU_IP_DEL_VPS
```

A partir de ahora te conectas sin contraseña.

---

## Paso 3 — Instalar Docker (si no lo tienes)

Si elegiste "Ubuntu with Docker" en Hostinger, ya lo tienes instalado. Verifícalo con:

```bash
docker --version
docker compose version
```

Si NO lo tienes:

```bash
# Instalar Docker
curl -fsSL https://get.docker.com | sh

# Verificar
docker --version
docker compose version
```

---

## Paso 4 — Subir los archivos del servidor

Desde tu ordenador (donde tienes el proyecto clonado), ejecuta:

```bash
# Copiar la carpeta server/ al VPS
scp -r server/ root@TU_IP_DEL_VPS:/opt/apliarte-agent/
```

Esto copia todos los archivos necesarios a `/opt/apliarte-agent/` en el servidor.

> 💡 Si hiciste `git clone` del repositorio en el VPS, la carpeta `server/` ya está ahí. En ese caso:
> ```bash
> ssh root@TU_IP_DEL_VPS
> git clone https://github.com/erbolamm/apliarte-ai.git /opt/apliarte-agent-repo
> cp -r /opt/apliarte-agent-repo/server /opt/apliarte-agent
> ```

---

## Paso 5 — Configurar las variables de entorno

Conéctate al servidor y crea el archivo `.env`:

```bash
ssh root@TU_IP_DEL_VPS
cd /opt/apliarte-agent
cp .env.example .env
```

Ahora edita el `.env`:

```bash
nano .env
```

### Variables que TIENES que cambiar

```env
# === OBLIGATORIO ===

# URL de tu AI Gateway o API directa del proveedor de LLM
# Ejemplos:
#   - Si usas LiteLLM local:       http://litellm:4000/v1/chat/completions
#   - Si usas OpenAI directo:      https://api.openai.com/v1/chat/completions
#   - Si tienes un AI Gateway:      http://ai-gateway:3000/v1/chat/completions
AI_GATEWAY_URL=http://ai-gateway:3000/v1/chat/completions

# Clave de API para autenticar la extensión con tu servidor.
# Genera una clave segura con: openssl rand -hex 32
AGENT_API_KEYS=PEGA_AQUI_TU_CLAVE_GENERADA

# === OPCIONAL (los defaults funcionan si tienes Ollama y Redis en la misma red Docker) ===

# URL de Ollama (para generar embeddings de RAG)
OLLAMA_URL=http://ollama:11434

# URL de Redis (para caché)
REDIS_URL=redis://redis:6379

# Modelo de embeddings (nomic-embed-text funciona bien y es liviano)
EMBED_MODEL=nomic-embed-text

# Máximo de archivos a indexar por workspace
MAX_INDEX_FILES=2000
```

Para generar una clave API segura:

```bash
openssl rand -hex 32
```

Copia el resultado y pégalo en `AGENT_API_KEYS`.

Guarda el archivo: `Ctrl + O`, Enter, `Ctrl + X`.

---

## Paso 6 — Levantar los servicios

### Si ya tienes Ollama y Redis corriendo (en Docker)

Asegúrate de que estén en la red `proxy_default`:

```bash
# Ver qué redes Docker existen
docker network ls

# Si no existe proxy_default, créala
docker network create proxy_default
```

Levanta el servidor:

```bash
cd /opt/apliarte-agent
docker compose up -d --build
```

### Si NO tienes Ollama ni Redis

Edita `docker-compose.yml` y descomenta las secciones de Redis y Ollama:

```bash
nano docker-compose.yml
```

Descomenta estas líneas (quita el `#` del inicio):

```yaml
  redis:
    image: redis:7-alpine
    container_name: redis
    restart: unless-stopped
    ports:
      - "6379:6379"
```

Después de levantar, descarga el modelo de embeddings en Ollama:

```bash
docker exec ollama ollama pull nomic-embed-text
```

---

## Paso 7 — Verificar que funciona

```bash
# Verificar que el contenedor está corriendo
docker ps | grep apliarte-code-agent

# Ver los logs
docker logs apliarte-code-agent --tail 50

# Probar el health check
curl http://localhost:8100/health
```

Deberías ver:

```json
{"status": "ok"}
```

Si ves un error, revisa los logs con `docker logs apliarte-code-agent` y la sección de [Solución de problemas](#solución-de-problemas).

---

## Paso 8 — Configurar un dominio (opcional pero recomendado)

Para acceder por HTTPS con un dominio bonito (ej: `agent.tudominio.com`), necesitas un **reverse proxy**. Si usas **Nginx Proxy Manager**:

1. Entra al panel de Nginx Proxy Manager (normalmente en `http://TU_IP:81`)
2. Añade un nuevo **Proxy Host**:
   - **Domain**: `agent.tudominio.com`
   - **Forward**: `apliarte-code-agent` port `8100`
   - **SSL**: habilita "Force SSL" y "Request a new SSL certificate"
3. En tu DNS (donde compraste el dominio), crea un registro **A**:
   - **Nombre**: `agent`
   - **Valor**: `TU_IP_DEL_VPS`

Si prefieres **Nginx directo** (sin panel), crea el archivo de configuración:

```bash
nano /etc/nginx/sites-available/agent.tudominio.com
```

```nginx
server {
    listen 80;
    server_name agent.tudominio.com;

    location / {
        proxy_pass http://localhost:8100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;              # Importante para SSE streaming
        proxy_cache off;
        proxy_read_timeout 300s;          # Tool calls pueden tardar
    }
}
```

```bash
ln -s /etc/nginx/sites-available/agent.tudominio.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# SSL gratis con Certbot
certbot --nginx -d agent.tudominio.com
```

---

## Paso 9 — Conectar la extensión

En VS Code, abre los Settings (`Cmd + ,` / `Ctrl + ,`) y busca "apliarte":

| Setting | Valor |
|---------|-------|
| `apliarteAi.agentEndpoint` | `https://agent.tudominio.com` (o `http://TU_IP:8100` si no tienes dominio) |
| `apliarteAi.agentApiKey` | La clave que generaste en el Paso 5 |

En el chat de ApliArte AI, selecciona **"🚀 Agent (Cloud)"** en el selector de proveedor. Si todo está bien, verás **"Agent ⚡"** en el indicador de conexión.

### Indexar tu workspace (opcional)

Abre la paleta de comandos (`Cmd + Shift + P`) y ejecuta:

```
ApliArte AI: 📡 Indexar workspace (RAG)
```

Esto envía la estructura de tu proyecto al servidor para que el agente pueda buscar contexto relevante cuando le preguntes sobre tu código.

---

## Solución de problemas

### "Agent offline" en la extensión

1. Verifica que el servidor está corriendo: `docker ps | grep apliarte-code-agent`
2. Verifica el health: `curl http://TU_IP:8100/health`
3. Si usas dominio, verifica que el DNS apunte a la IP correcta: `nslookup agent.tudominio.com`
4. Verifica que el puerto 8100 no esté bloqueado por firewall: `ufw allow 8100`

### Error 401 (Unauthorized)

La API key no coincide. Verifica que:
- El valor en VS Code (`apliarteAi.agentApiKey`) sea **exactamente** igual al de `.env` (`AGENT_API_KEYS`)
- No haya espacios extra al principio o final

### Error 502 (Bad Gateway)

El AI Gateway no está respondiendo. Verifica:
- Que el servicio `ai-gateway` (o el proveedor LLM que uses) esté corriendo
- Que la URL en `AI_GATEWAY_URL` sea correcta
- Logs: `docker logs apliarte-code-agent --tail 100`

### Embeddings no funcionan

Ollama necesita tener el modelo de embeddings descargado:

```bash
docker exec ollama ollama pull nomic-embed-text
docker exec ollama ollama list   # Verificar que aparece
```

### El servidor se reinicia constantemente

Revisa los logs:

```bash
docker logs apliarte-code-agent --tail 100
```

Causas comunes:
- `.env` mal configurado (variable faltante o con formato inválido)
- Redis no accesible (verifica que está corriendo y en la misma red Docker)

---

## Arquitectura del servidor

```
┌──────────────────────────────┐        ┌────────────────────────────┐
│  VS Code (ApliArte AI)       │        │  Tu VPS                    │
│                              │ HTTPS  │                            │
│  Chat UI ──────────────────────────►  /v1/chat (SSE streaming)    │
│  Indexar workspace ────────────────►  /v1/index (embeddings)      │
│  Tool results ─────────────────────►  /v1/tool-result             │
│                              │        │                            │
│  Ejecuta herramientas LOCAL  │        │  Proxy a AI Gateway/LLM    │
│  (read/write/search/terminal)│        │  Vector search (RAG)       │
│                              │        │  Auth (API key)            │
└──────────────────────────────┘        └────────────────────────────┘
                                                    │
                                                    ▼
                                        ┌────────────────────┐
                                        │  AI Gateway / LLM   │
                                        │  (OpenAI, Groq...)   │
                                        └────────────────────┘
```

### Endpoints

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/health` | GET | Health check — devuelve `{"status": "ok"}` |
| `/v1/chat` | POST | Chat con streaming (SSE). Proxea al LLM con RAG y herramientas |
| `/v1/tool-result` | POST | Continúa la conversación después de ejecutar una herramienta |
| `/v1/index` | POST | Recibe archivos del workspace y genera embeddings para RAG |
| `/v1/search` | POST | Búsqueda por similitud en los embeddings indexados |
| `/v1/auth/validate` | POST | Valida la API key |

### Seguridad

- Todas las peticiones requieren `Authorization: Bearer TU_API_KEY`
- Las herramientas (readFile, writeFile, runTerminal) se ejecutan **en el ordenador del usuario**, nunca en el servidor
- El servidor solo ve los archivos que el usuario indexe explícitamente (comando "Indexar workspace")
- CORS abierto pero protegido por Bearer token

---

## Actualizar el servidor

Cuando haya una nueva versión:

```bash
cd /opt/apliarte-agent

# Si clonaste el repo
git pull

# Reconstruir y reiniciar
docker compose up -d --build
```

---

## Licencia

MIT — © 2026 ApliArte
