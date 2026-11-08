import type { I18n } from '../i18n';
import { el } from '../safe';

export function createComposer(i18n: I18n, maxChars: number, onSend: (text: string) => void) {
  const { t } = i18n;
  const input = el('textarea', {
    id: 'shopchat-input',
    class: 'input',
    rows: '1',
    placeholder: t('placeholder'),
    maxlength: String(maxChars),
    'aria-describedby': 'shopchat-count',
    enterkeyhint: 'send',
  });
  const count = el('div', { id: 'shopchat-count', class: 'count', 'aria-live': 'polite' });
  const send = el('button', { type: 'submit', class: 'btn send', 'aria-label': t('send') }, '➤');
  const form = el('form', { class: 'composer' },
    el('label', { for: 'shopchat-input', class: 'sr-only' }, t('inputLabel')),
    input,
    send,
    count,
  );

  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden';
    const left = maxChars - input.value.length;
    count.textContent = left <= 200 ? t('charsLeft', { n: left }) : '';
  };
  const submit = () => {
    if (send.disabled || !input.value.trim()) return;
    onSend(input.value);
    input.value = '';
    resize();
  };

  input.addEventListener('input', resize);
  input.style.overflowY = 'hidden';
  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter adds a line; never while an IME is composing.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  return {
    element: form,
    focus: () => input.focus(),
    setBusy(busy: boolean) {
      send.disabled = busy;
    },
  };
}
