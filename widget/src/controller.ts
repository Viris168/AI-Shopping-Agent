// Turns user actions into API calls and stream events into state changes.

import { ApiError, type ChatApi, type SseEvent } from './api';
import type { I18n } from './i18n';
import { uid } from './safe';
import type { Message, Store } from './state';

export interface ControllerOptions {
  maxChars: number;
  /** Fired for every cart card, so the host page can refresh its cart badge. */
  onCartUpdated: (cart: unknown) => void;
  /** Screen-reader announcement once a reply is complete. */
  announce: (text: string) => void;
}

export class Controller {
  constructor(
    private readonly store: Store,
    private readonly api: ChatApi,
    private readonly i18n: I18n,
    private readonly opts: ControllerOptions,
  ) {}

  async send(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || this.store.state.busy) return;
    if (text.length > this.opts.maxChars) {
      this.addError(this.i18n.t('errTooLong', { max: this.opts.maxChars }), false);
      return;
    }
    this.store.add({ id: uid(), role: 'user', text, cards: [], status: 'done' });
    await this.ask(text);
  }

  /** Re-asks the user message before a failed reply. Safe: a failed turn isn't saved server-side. */
  async retry(failedId: string): Promise<void> {
    const messages = this.store.state.messages;
    const index = messages.findIndex((m) => m.id === failedId);
    const question = messages
      .slice(0, index)
      .reverse()
      .find((m) => m.role === 'user');
    if (!question || this.store.state.busy) return;
    this.store.remove(failedId);
    await this.ask(question.text);
  }

  async confirm(actionId: string): Promise<void> {
    if (this.store.state.busy) return;
    this.store.updateConfirm(actionId, 'working');
    const ok = await this.consume(() => this.api.confirm(actionId));
    this.store.updateConfirm(actionId, ok === 'expired' ? 'expired' : 'confirmed');
  }

  async cancel(actionId: string): Promise<void> {
    this.store.updateConfirm(actionId, 'working');
    try {
      await this.api.cancel(actionId);
      this.store.updateConfirm(actionId, 'cancelled');
    } catch (err) {
      this.store.updateConfirm(actionId, err instanceof ApiError && err.status === 409 ? 'expired' : 'pending');
    }
  }

  async rate(messageId: string, rating: 'up' | 'down'): Promise<void> {
    const { conversationId, messages } = this.store.state;
    const message = messages.find((m) => m.id === messageId);
    if (!conversationId || !message?.serverId || message.rating) return;
    this.store.updateMessage(messageId, (m) => ({ ...m, rating }));
    try {
      await this.api.feedback({ conversationId, messageId: message.serverId, rating });
    } catch {
      // Feedback is best-effort.
    }
  }

  reset(): void {
    if (this.store.state.busy) return;
    this.store.set({ conversationId: null, messages: [] });
  }

  private async ask(text: string, allowReset = true): Promise<void> {
    const result = await this.consume(() =>
      this.api.chat({
        conversationId: this.store.state.conversationId,
        message: text,
        locale: this.i18n.locale,
      }),
    );
    // 403: the saved conversation belongs to a different login. Start fresh, once.
    if (result === 'forbidden' && allowReset) {
      this.store.set({ conversationId: null });
      await this.ask(text, false);
    }
  }

  /** Streams one reply into a new assistant message. */
  private async consume(
    open: () => AsyncGenerator<SseEvent>,
  ): Promise<'ok' | 'forbidden' | 'expired' | 'error'> {
    const id = uid();
    this.store.add({ id, role: 'assistant', text: '', cards: [], status: 'streaming' });
    this.store.set({ busy: true });
    const update = (fn: (m: Message) => Message) => this.store.updateMessage(id, fn);
    let result: 'ok' | 'forbidden' | 'expired' | 'error' = 'ok';

    try {
      for await (const { event, data } of open()) {
        switch (event) {
          case 'meta':
            this.store.set({ conversationId: data.conversationId });
            update((m) => ({ ...m, serverId: data.messageId }));
            break;
          case 'text_delta':
            update((m) => ({ ...m, text: m.text + data.text }));
            break;
          case 'card':
            update((m) => ({ ...m, cards: [...m.cards, data] }));
            if (data.type === 'cart') this.opts.onCartUpdated(data.data);
            break;
          case 'confirm_request':
            update((m) => ({ ...m, cards: [...m.cards, { type: 'confirm', data: { ...data, state: 'pending' } }] }));
            break;
          case 'handoff':
            update((m) => ({ ...m, cards: [...m.cards, { type: 'handoff', data }] }));
            break;
          case 'memory':
            update((m) => ({ ...m, cards: [{ type: 'memory', data }, ...m.cards] }));
            break;
          case 'error':
            if (data.code === 'action_expired') result = 'expired';
            else result = 'error';
            update((m) => ({
              ...m,
              status: 'error',
              error: {
                message: data.message || this.i18n.t('errGeneric'),
                retryable: Boolean(data.retryable),
                ...(data.code === 'model_unavailable' && { fallback: true }),
              },
            }));
            break;
        }
      }
    } catch (err) {
      result = this.fail(id, err);
    } finally {
      const final = this.store.state.messages.find((m) => m.id === id);
      if (final?.status === 'streaming') update((m) => ({ ...m, status: 'done' }));
      if (result === 'forbidden') this.store.remove(id);
      this.store.set({ busy: false });
      if (final?.text) this.opts.announce(final.text);
    }
    return result;
  }

  private fail(id: string, err: unknown): 'forbidden' | 'expired' | 'error' {
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 403) return 'forbidden';
    if (status === 409) {
      this.store.remove(id);
      return 'expired';
    }
    const t = this.i18n.t;
    // Spend limits (agent-service app/limits.py): retrying won't help until the limit resets.
    const limit = err instanceof ApiError ? err.limit : undefined;
    const limitMessage =
      status === 429 && limit
        ? ({
            shopper_daily: t('errDailyLimit'),
            conversation: t('errConversationLimit'),
            guests_paused: t('errGuestsPaused'),
            new_chats: t('errTooManyChats'),
          } as Record<string, string>)[limit]
        : undefined;
    const [message, retryable] = limitMessage
      ? [limitMessage, false]
      : status === 413
        ? [t('errTooLong', { max: this.opts.maxChars }), false]
        : status === 429
          ? [t('errRateLimited'), true]
          : status === 503
            ? [t('errUnavailable'), false]
            : status === 0
              ? [t('errNetwork'), true]
              : [t('errGeneric'), true];
    // 503: the kill switch is on. Show the fallback card; the next page load hides the widget.
    const error = { message, retryable, ...(status === 503 && { fallback: true }) };
    this.store.updateMessage(id, (m) => ({ ...m, status: 'error', error }));
    return 'error';
  }

  private addError(message: string, retryable: boolean): void {
    this.store.add({
      id: uid(),
      role: 'assistant',
      text: '',
      cards: [],
      status: 'error',
      error: { message, retryable },
    });
  }
}
