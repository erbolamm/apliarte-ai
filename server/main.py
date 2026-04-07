"""
ApliArte AI — Code Agent Backend
Runs on VPS. Provides: chat proxy with tool-calling, RAG via embeddings, auth.
"""
import os
import json
import time
import hashlib
import logging
import asyncio
from typing import Optional
from contextlib import asynccontextmanager

import httpx
import numpy as np
import redis.asyncio as redis
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
AI_GATEWAY_URL = os.getenv("AI_GATEWAY_URL", "http://ai-gateway:3000/v1/chat/completions")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")
API_KEYS = set(os.getenv("AGENT_API_KEYS", "").split(","))  # comma-separated valid keys
EMBED_MODEL = os.getenv("EMBED_MODEL", "nomic-embed-text")
MAX_INDEX_FILES = int(os.getenv("MAX_INDEX_FILES", "2000"))
EMBED_DIM = 768  # nomic-embed-text dimension

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("agent")

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
redis_client: Optional[redis.Redis] = None

# In-memory vector store per workspace (workspace_id → {files, embeddings})
# For MVP. Production would use pgvector or dedicated vector DB.
vector_stores: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client
    try:
        redis_client = redis.from_url(REDIS_URL, decode_responses=True)
        await redis_client.ping()
        logger.info("Connected to Redis")
    except Exception as e:
        logger.warning(f"Redis not available: {e}. Sessions disabled.")
        redis_client = None
    yield
    if redis_client:
        await redis_client.close()

app = FastAPI(title="ApliArte Code Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Extension connects from vscode-webview origin
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
async def verify_api_key(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Missing API key")
    key = auth[7:]
    if key not in API_KEYS:
        raise HTTPException(403, "Invalid API key")
    return key

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
AGENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "readFile",
            "description": "Read the contents of a file in the user's workspace",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path from workspace root"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "writeFile",
            "description": "Write content to a file in the user's workspace. Creates the file if it doesn't exist.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path from workspace root"},
                    "content": {"type": "string", "description": "Full file content to write"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "listFiles",
            "description": "List files in a directory of the user's workspace",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative directory path (empty string for root)"},
                    "recursive": {"type": "boolean", "description": "Whether to list recursively", "default": False},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "searchCode",
            "description": "Search for text or regex pattern in the user's workspace files",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text or regex pattern to search for"},
                    "path": {"type": "string", "description": "Optional: limit search to this directory", "default": ""},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "runTerminal",
            "description": "Execute a shell command in the user's workspace terminal. Use for running tests, builds, git commands, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute"},
                },
                "required": ["command"],
            },
        },
    },
]

class ChatRequest(BaseModel):
    messages: list[dict]
    workspace_id: Optional[str] = None
    tools_enabled: bool = True
    model: Optional[str] = None
    temperature: float = 0.7

class ToolResultRequest(BaseModel):
    messages: list[dict]  # Full conversation including tool results
    workspace_id: Optional[str] = None
    model: Optional[str] = None
    temperature: float = 0.7

class IndexRequest(BaseModel):
    workspace_id: str
    files: list[dict]  # [{path: str, content: str}, ...]

class SearchRequest(BaseModel):
    workspace_id: str
    query: str
    top_k: int = 10

# ---------------------------------------------------------------------------
# Embeddings (via Ollama)
# ---------------------------------------------------------------------------
async def get_embedding(text: str) -> list[float]:
    """Get embedding vector from Ollama's nomic-embed-text."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": EMBED_MODEL, "prompt": text[:8000]},  # Truncate to avoid OOM
        )
        resp.raise_for_status()
        return resp.json()["embedding"]


async def get_embeddings_batch(texts: list[str]) -> list[list[float]]:
    """Get embeddings for multiple texts. Sequential to avoid Ollama overload on 2-core."""
    results = []
    for text in texts:
        emb = await get_embedding(text)
        results.append(emb)
    return results

# ---------------------------------------------------------------------------
# Vector store (in-memory MVP)
# ---------------------------------------------------------------------------
def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def search_vectors(workspace_id: str, query_vec: list[float], top_k: int = 10) -> list[dict]:
    """Search indexed files by cosine similarity."""
    store = vector_stores.get(workspace_id)
    if not store or not store["embeddings"]:
        return []

    q = np.array(query_vec)
    scored = []
    for i, emb in enumerate(store["embeddings"]):
        sim = cosine_similarity(q, np.array(emb))
        scored.append((sim, store["files"][i]))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [{"score": round(s, 4), **f} for s, f in scored[:top_k]]

# ---------------------------------------------------------------------------
# Chat proxy with streaming
# ---------------------------------------------------------------------------
async def proxy_chat_stream(messages: list[dict], tools: Optional[list] = None,
                            model: Optional[str] = None, temperature: float = 0.7):
    """
    Stream chat from ai-gateway. Yields SSE events:
    - event: chunk  data: {"text": "..."}
    - event: tool_call  data: {"id": "...", "name": "...", "arguments": {...}}
    - event: done  data: {}
    - event: error  data: {"text": "..."}
    """
    payload = {
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 4096,
        "stream": True,
    }
    if model:
        payload["model"] = model
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream("POST", AI_GATEWAY_URL, json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    yield f"event: error\ndata: {json.dumps({'text': f'LLM error {resp.status_code}: {body.decode()[:200]}'})}\n\n"
                    return

                tool_calls_acc: dict[int, dict] = {}  # index → {id, name, arguments_str}
                current_content = ""

                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        break

                    try:
                        data = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue

                    choice = data.get("choices", [{}])[0]
                    delta = choice.get("delta", {})

                    # Text content
                    if delta.get("content"):
                        current_content += delta["content"]
                        yield f"event: chunk\ndata: {json.dumps({'text': delta['content']})}\n\n"

                    # Tool calls (streamed in parts)
                    if delta.get("tool_calls"):
                        for tc in delta["tool_calls"]:
                            idx = tc.get("index", 0)
                            if idx not in tool_calls_acc:
                                tool_calls_acc[idx] = {
                                    "id": tc.get("id", ""),
                                    "name": tc.get("function", {}).get("name", ""),
                                    "arguments_str": "",
                                }
                            if tc.get("id"):
                                tool_calls_acc[idx]["id"] = tc["id"]
                            if tc.get("function", {}).get("name"):
                                tool_calls_acc[idx]["name"] = tc["function"]["name"]
                            if tc.get("function", {}).get("arguments"):
                                tool_calls_acc[idx]["arguments_str"] += tc["function"]["arguments"]

                    # Check finish reason
                    if choice.get("finish_reason") == "tool_calls":
                        for idx in sorted(tool_calls_acc.keys()):
                            tc = tool_calls_acc[idx]
                            try:
                                args = json.loads(tc["arguments_str"])
                            except json.JSONDecodeError:
                                args = {"_raw": tc["arguments_str"]}
                            yield f"event: tool_call\ndata: {json.dumps({'id': tc['id'], 'name': tc['name'], 'arguments': args})}\n\n"
                        return  # Don't send 'done' — extension must call back with tool results

                yield f"event: done\ndata: {json.dumps({})}\n\n"

    except httpx.ConnectError:
        yield f"event: error\ndata: {json.dumps({'text': 'Cannot connect to AI Gateway. Is it running?'})}\n\n"
    except Exception as e:
        logger.exception("Chat proxy error")
        yield f"event: error\ndata: {json.dumps({'text': str(e)[:200]})}\n\n"

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {"status": "ok", "service": "apliarte-code-agent", "timestamp": int(time.time())}


@app.post("/v1/chat")
async def chat(req: ChatRequest, api_key: str = Depends(verify_api_key)):
    """
    Chat with tool-calling support. Returns SSE stream.
    Events: chunk (text), tool_call (model wants a tool), done, error.
    """
    # If workspace is indexed, inject relevant context via RAG
    messages = list(req.messages)
    if req.workspace_id and req.workspace_id in vector_stores:
        # Get the last user message for RAG query
        last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), None)
        if last_user:
            try:
                query_emb = await get_embedding(last_user)
                results = search_vectors(req.workspace_id, query_emb, top_k=5)
                if results:
                    context = "\n\n".join(
                        f"--- {r['path']} (relevance: {r['score']}) ---\n{r.get('content', '')[:2000]}"
                        for r in results if r["score"] > 0.3
                    )
                    if context:
                        # Inject RAG context as a system message
                        rag_msg = {
                            "role": "system",
                            "content": f"Relevant code from the user's workspace:\n\n{context}",
                        }
                        # Insert after the first system message
                        insert_idx = 1 if messages and messages[0]["role"] == "system" else 0
                        messages.insert(insert_idx, rag_msg)
            except Exception as e:
                logger.warning(f"RAG search failed: {e}")

    tools = AGENT_TOOLS if req.tools_enabled else None

    return StreamingResponse(
        proxy_chat_stream(messages, tools=tools, model=req.model, temperature=req.temperature),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/v1/tool-result")
async def tool_result(req: ToolResultRequest, api_key: str = Depends(verify_api_key)):
    """
    Continue chat after tool execution. The extension sends back the full
    conversation including tool call + tool result messages.
    Returns SSE stream (same format as /v1/chat).
    """
    return StreamingResponse(
        proxy_chat_stream(req.messages, tools=AGENT_TOOLS, model=req.model, temperature=req.temperature),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/v1/index")
async def index_workspace(req: IndexRequest, api_key: str = Depends(verify_api_key)):
    """
    Index workspace files for RAG search. Receives file paths + contents,
    generates embeddings via Ollama, stores in memory.
    """
    if len(req.files) > MAX_INDEX_FILES:
        raise HTTPException(400, f"Too many files. Max {MAX_INDEX_FILES}")

    # Filter empty files and truncate
    files_to_index = [
        {"path": f["path"], "content": f["content"][:8000]}
        for f in req.files
        if f.get("content", "").strip()
    ]

    if not files_to_index:
        return {"indexed": 0, "workspace_id": req.workspace_id}

    logger.info(f"Indexing {len(files_to_index)} files for workspace {req.workspace_id[:8]}...")

    # Generate embeddings
    texts = [f"{f['path']}\n{f['content']}" for f in files_to_index]
    embeddings = await get_embeddings_batch(texts)

    vector_stores[req.workspace_id] = {
        "files": files_to_index,
        "embeddings": embeddings,
        "indexed_at": int(time.time()),
    }

    logger.info(f"Indexed {len(files_to_index)} files for workspace {req.workspace_id[:8]}")
    return {"indexed": len(files_to_index), "workspace_id": req.workspace_id}


@app.post("/v1/search")
async def search_workspace(req: SearchRequest, api_key: str = Depends(verify_api_key)):
    """Search indexed workspace files by semantic similarity."""
    if req.workspace_id not in vector_stores:
        raise HTTPException(404, "Workspace not indexed. Call /v1/index first.")

    query_emb = await get_embedding(req.query)
    results = search_vectors(req.workspace_id, query_emb, top_k=req.top_k)
    return {"results": results, "query": req.query}


@app.post("/v1/auth/validate")
async def validate_auth(api_key: str = Depends(verify_api_key)):
    """Validate API key. Returns 200 if valid, 401/403 if not."""
    return {"valid": True}


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100)
