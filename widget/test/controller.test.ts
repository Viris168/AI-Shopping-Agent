import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatApi } from '../src/api';
import { Controller } from '../src/controller';
import { createI18n } from '../src/i18n';
import { Store } from '../src/state';
import { jsonResponse, mockFetch, sse, sseResponse } from './helpers';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const store = new Store('k', null);
  const onCartUpdated = vi.fn();
  const announce = vi.fn();
  const controller = new Controller(store, new ChatApi('https://chat.test', () => null, 0), createI18n('en'), {
    maxChars: 2000,
    onCartUpdated,
    announce,
  });
  return { store, controller, onCartUpdated, announce };
}

const CART = { type: 'cart', data: { itemCount: 2, items: [] } };

describe('Controller', () => {
  it('streams a reply with cards and a confirm request into state', async () => {
    mockFetch(
      sseResponse(
        sse(
          ['meta', { conversationId: 'c1', messageId: 'srv-1' }],
          ['text_delta', { text: 'Added. ' }],
          ['card', CART],
          ['text_delta', { text: 'Confirm the return?' }],
          ['confirm_request', { actionId: 'a1', kind: 'create_return', summary: 'Return 1 × Shoes', expiresAt: '2999-01-01T00:00:00Z' }],
          ['done', { usage: {} }],
        ),
      ),
    );
    const { store, controller, onCartUpdated, announce } = setup();
    await controller.send('  add shoes  ');

    const [user, reply] = store.state.messages;
    expect(user).toMatchObject({ role: 'user', text: 'add shoes' });
    expect(reply).toMatchObject({ role: 'assistant', text: 'Added. Confirm the return?', status: 'done', serverId: 'srv-1' });
    expect(reply.cards.map((c) => c.type)).toEqual(['cart', 'confirm']);
    expect(reply.cards[1].data.state).toBe('pending');
    expect(store.state).toMatchObject({ conversationId: 'c1', busy: false });
    expect(onCartUpdated).toHaveBeenCalledWith(CART.data);
    expect(announce).toHaveBeenCalledWith('Added. Confirm the return?');
  });

  it('sends the conversation id on later turns', async () => {
    const fetch = mockFetch(sseResponse(sse(['meta', { conversationId: 'c1', messageId: 'm' }])), sseResponse(''));
    const { controller } = setup();
    await controller.send('one');
    await controller.send('two');
    const body = JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body.conversationId).toBe('c1');
  });

  it('shows friendly errors and retries the same question', async () => {
    const fetch = mockFetch(jsonResponse(429), sseResponse(sse(['text_delta', { text: 'Hi' }], ['done', {}])));
    const { store, controller } = setup();
    await controller.send('hello');
    const failed = store.state.messages[1];
    expect(failed.error).toEqual({ message: "You're sending messages quickly. Please wait a moment.", retryable: true });

    await controller.retry(failed.id);
    expect(store.state.messages.map((m) => m.text)).toEqual(['hello', 'Hi']);
    expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).message).toBe('hello');
  });

  it('explains spend limits without offering a retry', async () => {
    mockFetch(
      jsonResponse(429, { detail: "You've reached today's limit." }, { 'X-Limit': 'shopper_daily' }),
      jsonResponse(429, { detail: 'Please sign in.' }, { 'X-Limit': 'guests_paused' }),
    );
    const { store, controller } = setup();
    await controller.send('hello');
    await controller.send('hello again');
    const errors = store.state.messages.filter((m) => m.error).map((m) => m.error);
    expect(errors).toEqual([
      { message: "You've reached today's limit for the assistant. Please try again tomorrow, or contact us.", retryable: false },
      { message: 'The assistant is busy right now. Please sign in to keep chatting.', retryable: false },
    ]);
  });

  it('flags a model outage and the kill switch for the fallback card', async () => {
    mockFetch(
      sseResponse(sse(['error', { code: 'model_unavailable', message: "The assistant can't answer right now.", retryable: true }], ['done', {}])),
      jsonResponse(503, { detail: 'The assistant is unavailable right now.' }),
    );
    const { store, controller } = setup();
    await controller.send('one');
    await controller.send('two');
    const [outage, killed] = [store.state.messages[1], store.state.messages[3]];
    expect(outage.error).toMatchObject({ retryable: true, fallback: true });
    expect(killed.error).toMatchObject({ retryable: false, fallback: true });
  });

  it('starts a fresh conversation once when the saved one belongs to another login', async () => {
    const fetch = mockFetch(jsonResponse(403), sseResponse(sse(['meta', { conversationId: 'c2', messageId: 'm' }], ['done', {}])));
    const { store, controller } = setup();
    store.set({ conversationId: 'c-old' });
    await controller.send('hi');
    expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).conversationId).toBeUndefined();
    expect(store.state.conversationId).toBe('c2');
    expect(store.state.messages).toHaveLength(2);
  });

  it('confirms through the confirm endpoint and marks the card', async () => {
    const fetch = mockFetch(
      sseResponse(sse(['confirm_request', { actionId: 'a1', kind: 'create_return', summary: 's', expiresAt: '2999-01-01T00:00:00Z' }])),
      sseResponse(sse(['card', { type: 'return_created', data: { returnId: 'r1' } }], ['text_delta', { text: 'Done.' }], ['done', {}])),
    );
    const { store, controller } = setup();
    await controller.send('return it');
    await controller.confirm('a1');
    expect((fetch.mock.calls[1] as unknown as [string])[0]).toBe('https://chat.test/v1/actions/a1/confirm');
    expect(store.state.messages[1].cards[0].data.state).toBe('confirmed');
    expect(store.state.messages[2].cards[0].type).toBe('return_created');
  });

  it('marks an already-used action as expired', async () => {
    mockFetch(
      sseResponse(sse(['confirm_request', { actionId: 'a1', kind: 'k', summary: 's', expiresAt: '2999-01-01T00:00:00Z' }])),
      jsonResponse(409),
    );
    const { store, controller } = setup();
    await controller.send('x');
    await controller.confirm('a1');
    expect(store.state.messages[1].cards[0].data.state).toBe('expired');
    expect(store.state.messages).toHaveLength(2);
  });

  it('rejects messages over the limit without calling the API', async () => {
    const fetch = mockFetch();
    const { store, controller } = setup();
    await controller.send('x'.repeat(2001));
    expect(fetch).not.toHaveBeenCalled();
    expect(store.state.messages[0].error?.message).toBe('Messages can be up to 2000 characters.');
  });
});
