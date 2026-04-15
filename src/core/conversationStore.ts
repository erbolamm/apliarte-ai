import * as vscode from 'vscode';
import type { ChatMessage } from './llmService';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;       // First user message truncated
  provider: string;
  model: string;
}

export interface Conversation extends ConversationMeta {
  messages: ChatMessage[];
}

// ── Keys ─────────────────────────────────────────────────────────────────────

const KEY_INDEX    = 'conv:index';
const KEY_ACTIVE   = 'conv:active';
const convKey      = (id: string) => `conv:data:${id}`;
const MAX_STORED   = 50;   // Max conversations to keep

// ── ConversationStore ────────────────────────────────────────────────────────

export class ConversationStore {
  constructor(private readonly _state: vscode.Memento) {}

  // ── Index ──────────────────────────────────────────────────────────────────

  private _getIndex(): ConversationMeta[] {
    return this._state.get<ConversationMeta[]>(KEY_INDEX, []);
  }

  private async _setIndex(index: ConversationMeta[]): Promise<void> {
    await this._state.update(KEY_INDEX, index);
  }

  // ── Active session ─────────────────────────────────────────────────────────

  getActiveId(): string | undefined {
    return this._state.get<string>(KEY_ACTIVE);
  }

  async setActiveId(id: string): Promise<void> {
    await this._state.update(KEY_ACTIVE, id);
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async createConversation(provider = 'remote', model = ''): Promise<Conversation> {
    const id  = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const conv: Conversation = {
      id,
      title: 'Nueva conversación',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      preview: '',
      provider,
      model,
      messages: [],
    };

    await this._saveConversation(conv);
    await this.setActiveId(id);

    // Prepend to index
    const index = this._getIndex();
    index.unshift(this._toMeta(conv));
    // Enforce max stored
    if (index.length > MAX_STORED) {
      const removed = index.splice(MAX_STORED);
      for (const old of removed) {
        await this._state.update(convKey(old.id), undefined);
      }
    }
    await this._setIndex(index);
    return conv;
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    return this._state.get<Conversation>(convKey(id));
  }

  async getOrCreateActive(provider = 'remote', model = ''): Promise<Conversation> {
    const activeId = this.getActiveId();
    if (activeId) {
      const conv = await this.getConversation(activeId);
      if (conv) return conv;
    }
    return this.createConversation(provider, model);
  }

  async saveMessages(
    id: string,
    messages: ChatMessage[],
    provider: string,
    model: string
  ): Promise<void> {
    const conv = await this.getConversation(id);
    if (!conv) return;

    const updated: Conversation = {
      ...conv,
      messages,
      messageCount: messages.filter((m) => m.role === 'user').length,
      updatedAt: Date.now(),
      provider,
      model,
      preview: this._buildPreview(messages),
      title: conv.title === 'Nueva conversación' ? this._buildTitle(messages) : conv.title,
    };

    await this._saveConversation(updated);

    // Update index
    const index = this._getIndex();
    const idx   = index.findIndex((m) => m.id === id);
    const meta  = this._toMeta(updated);
    if (idx >= 0) {
      index.splice(idx, 1);
    }
    index.unshift(meta);
    await this._setIndex(index);
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const conv = await this.getConversation(id);
    if (!conv) return;
    conv.title = title.trim() || 'Sin título';
    conv.updatedAt = Date.now();
    await this._saveConversation(conv);
    const index = this._getIndex();
    const idx   = index.findIndex((m) => m.id === id);
    if (idx >= 0) {
      index[idx].title     = conv.title;
      index[idx].updatedAt = conv.updatedAt;
    }
    await this._setIndex(index);
  }

  async deleteConversation(id: string): Promise<void> {
    await this._state.update(convKey(id), undefined);
    const index = this._getIndex().filter((m) => m.id !== id);
    await this._setIndex(index);
    if (this.getActiveId() === id) {
      await this._state.update(KEY_ACTIVE, undefined);
    }
  }

  listConversations(): ConversationMeta[] {
    return this._getIndex().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  async exportToMarkdown(id: string): Promise<string> {
    const conv = await this.getConversation(id);
    if (!conv) return '';

    const date = new Date(conv.createdAt).toLocaleString('es-ES');
    let md = `# ${conv.title}\n\n`;
    md += `> Exportado: ${date} | Proveedor: ${conv.provider} | Modelo: ${conv.model}\n\n---\n\n`;

    for (const msg of conv.messages) {
      const label = msg.role === 'user' ? '**Tú**' : '**ApliArte AI**';
      md += `${label}:\n\n${msg.content}\n\n---\n\n`;
    }

    return md;
  }

  async exportAllToMarkdown(): Promise<string> {
    const index = this.listConversations();
    let md = '# ApliArte AI — Todas las Conversaciones\n\n';
    md += `> Exportado: ${new Date().toLocaleString('es-ES')} | Total: ${index.length}\n\n`;

    for (const meta of index) {
      const conv = await this.getConversation(meta.id);
      if (!conv) continue;
      md += `## ${conv.title}\n`;
      md += `*${new Date(conv.createdAt).toLocaleDateString('es-ES')} — ${conv.messageCount} mensajes*\n\n`;
      for (const msg of conv.messages) {
        const label = msg.role === 'user' ? '**Tú**' : '**ApliArte AI**';
        md += `${label}: ${msg.content.slice(0, 300)}${msg.content.length > 300 ? '…' : ''}\n\n`;
      }
      md += '\n---\n\n';
    }

    return md;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async _saveConversation(conv: Conversation): Promise<void> {
    await this._state.update(convKey(conv.id), conv);
  }

  private _toMeta(conv: Conversation): ConversationMeta {
    return {
      id:           conv.id,
      title:        conv.title,
      createdAt:    conv.createdAt,
      updatedAt:    conv.updatedAt,
      messageCount: conv.messageCount,
      preview:      conv.preview,
      provider:     conv.provider,
      model:        conv.model,
    };
  }

  private _buildPreview(messages: ChatMessage[]): string {
    const first = messages.find((m) => m.role === 'user');
    if (!first) return '';
    return first.content.replace(/\[Contexto:[^\]]+\]\n```[\s\S]*?```\n\n/g, '').slice(0, 120);
  }

  private _buildTitle(messages: ChatMessage[]): string {
    const first = messages.find((m) => m.role === 'user');
    if (!first) return 'Nueva conversación';
    const clean = first.content.replace(/\[Contexto:[^\]]+\]\n```[\s\S]*?```\n\n/g, '').trim();
    return clean.slice(0, 60) + (clean.length > 60 ? '…' : '');
  }
}
