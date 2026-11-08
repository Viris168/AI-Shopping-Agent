import { describe, expect, it } from 'vitest';
import { Store } from '../src/state';
import { MemoryStorage } from './helpers';

describe('Store', () => {
  it('persists the conversation across page loads', () => {
    const storage = new MemoryStorage();
    const a = new Store('k', storage);
    a.set({ conversationId: 'c1', open: true });
    a.add({ id: 'm1', role: 'assistant', text: 'Hal', cards: [], status: 'streaming' });

    const b = new Store('k', storage);
    expect(b.state.conversationId).toBe('c1');
    expect(b.state.open).toBe(true);
    expect(b.state.busy).toBe(false);
    expect(b.state.messages[0]).toMatchObject({ text: 'Hal', status: 'done' });
  });

  it('marks confirm cards that expired while the page was away', () => {
    const storage = new MemoryStorage();
    const card = (actionId: string, expiresAt: string) => ({
      type: 'confirm',
      data: { actionId, state: 'pending', summary: 's', kind: 'create_return', expiresAt },
    });
    new Store('k', storage).add({
      id: 'm1', role: 'assistant', text: '', status: 'done',
      cards: [card('old', '2000-01-01T00:00:00Z'), card('new', '2999-01-01T00:00:00Z')],
    });
    const states = new Store('k', storage).state.messages[0].cards.map((c) => c.data.state);
    expect(states).toEqual(['expired', 'pending']);
  });

  it('works without storage', () => {
    const s = new Store('k', null);
    s.set({ open: true });
    expect(s.state.open).toBe(true);
  });
});
