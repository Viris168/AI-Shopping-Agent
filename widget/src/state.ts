// Conversation state, kept in sessionStorage so the chat survives page navigation (PRD F11).

export interface Card {
  type: string;
  data: any;
}

export type ConfirmState = 'pending' | 'working' | 'confirmed' | 'cancelled' | 'expired';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards: Card[];
  status: 'streaming' | 'done' | 'error';
  /** Server messageId from the `meta` event; needed for thumbs up/down. */
  serverId?: string;
  /** `fallback`: the assistant itself is down or switched off, not just this reply. */
  error?: { message: string; retryable: boolean; fallback?: boolean };
  rating?: 'up' | 'down';
}

export interface ChatState {
  conversationId: string | null;
  messages: Message[];
  open: boolean;
  busy: boolean;
}

const MAX_STORED_MESSAGES = 60;

export class Store {
  private value: ChatState;
  private readonly listeners = new Set<(s: ChatState) => void>();

  constructor(
    private readonly key: string,
    private readonly storage: Storage | null = safeSessionStorage(),
  ) {
    this.value = { conversationId: null, messages: [], open: false, busy: false, ...this.load() };
  }

  get state(): ChatState {
    return this.value;
  }

  subscribe(fn: (s: ChatState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<ChatState>): void {
    this.value = { ...this.value, ...patch };
    this.emit();
  }

  add(message: Message): void {
    this.set({ messages: [...this.value.messages, message] });
  }

  remove(id: string): void {
    this.set({ messages: this.value.messages.filter((m) => m.id !== id) });
  }

  updateMessage(id: string, fn: (m: Message) => Message): void {
    this.set({ messages: this.value.messages.map((m) => (m.id === id ? fn(m) : m)) });
  }

  /** Updates the confirm card for `actionId`, wherever it is in the conversation. */
  updateConfirm(actionId: string, state: ConfirmState): void {
    this.set({
      messages: this.value.messages.map((m) =>
        m.cards.some((c) => c.type === 'confirm' && c.data.actionId === actionId)
          ? {
              ...m,
              cards: m.cards.map((c) =>
                c.type === 'confirm' && c.data.actionId === actionId
                  ? { ...c, data: { ...c.data, state } }
                  : c,
              ),
            }
          : m,
      ),
    });
  }

  private emit(): void {
    this.save();
    for (const fn of this.listeners) fn(this.value);
  }

  private load(): Partial<ChatState> {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return {};
      const saved = JSON.parse(raw) as Partial<ChatState>;
      const now = Date.now();
      return {
        conversationId: saved.conversationId ?? null,
        open: Boolean(saved.open),
        // A reply that was still streaming when the page unloaded is gone; keep what arrived.
        messages: (saved.messages ?? []).map((m) => ({
          ...m,
          status: m.status === 'streaming' ? 'done' : m.status,
          cards: m.cards.map((c) =>
            c.type === 'confirm' &&
            ['pending', 'working'].includes(c.data.state) &&
            Date.parse(c.data.expiresAt) < now
              ? { ...c, data: { ...c.data, state: 'expired' } }
              : c,
          ),
        })),
      };
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      const { conversationId, messages, open } = this.value;
      this.storage?.setItem(
        this.key,
        JSON.stringify({ conversationId, open, messages: messages.slice(-MAX_STORED_MESSAGES) }),
      );
    } catch {
      // Storage full or blocked: the chat still works, it just won't survive navigation.
    }
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
