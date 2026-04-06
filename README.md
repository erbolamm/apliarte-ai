# Gentle AI Connect

Extensión de VS Code que conecta el ecosistema [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) con proveedores de IA locales (LM Studio, Ollama).

## ¿Qué hace?

1. **Detecta** si tenés LM Studio u Ollama corriendo en tu máquina
2. **Configura** Continue automáticamente con las rules del agente Gentleman
3. **Permite elegir preset** según la capacidad de tu modelo local

## Requisitos

- [Continue](https://marketplace.visualstudio.com/items?itemName=Continue.continue) instalado en VS Code
- [LM Studio](https://lmstudio.ai/) u [Ollama](https://ollama.ai/) con un modelo cargado

## Presets

| Preset | Tokens aprox. | Para qué modelos |
|--------|--------------|------------------|
| **Lite** (`minimal`) | ~5k | Modelos ≤ 8B (Gemma 4 4B, Phi-3) |
| **Medium** (`ecosystem-only`) | ~20k | Modelos 13B-30B (Llama 3 13B, Qwen 14B) |
| **Full** (`full-gentleman`) | ~49k | Modelos grandes o APIs (GPT-4o, Claude, Gemini) |

## Uso

1. Abrí la paleta de comandos (`Cmd + Shift + P`)
2. Escribí "Gentle AI"
3. Elegí: **Gentle AI: Configurar IA Local**
4. Seleccioná tu proveedor y modelo
5. Abrí Continue (`Cmd + L`) y empezá a conversar

## Cambiar Preset

- Paleta de comandos → **Gentle AI: Cambiar Preset (Full / Medium / Lite)**

## Roadmap

- [x] v0.1 — Detección de LM Studio/Ollama + configuración de Continue
- [ ] v0.2 — Selector visual de preset con preview de tokens
- [ ] v0.3 — Panel de chat propio (sin depender de Continue)
- [ ] v1.0 — Chat completo con streaming, contexto de archivos, @ mentions

## Créditos

- Ecosistema [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) por [Gentleman Programming](https://github.com/Gentleman-Programming)
- Extensión creada por [ApliArte](https://github.com/erbolamm)

## Licencia

MIT
