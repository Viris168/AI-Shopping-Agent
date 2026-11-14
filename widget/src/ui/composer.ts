import type { I18n } from '../i18n';
import { type Photo, PhotoError, preparePhoto } from '../photo';
import { type Dictation, type RecognitionCtor, speechLang, startDictation } from '../voice';
import { el } from '../safe';
import { button } from '../cards/product';

export function createComposer(
  i18n: I18n,
  maxChars: number,
  onSend: (text: string, photo?: Photo, via?: 'voice') => void,
  /** `photos`: show the attach button (agent-service /v1/config imagesEnabled).
   *  `voice`: the browser's recognizer when dictation is on and supported (PLAN-21); else no mic. */
  opts: {
    photos: boolean;
    prepare?: (file: Blob) => Promise<Photo>;
    voice?: RecognitionCtor | null;
  } = { photos: false },
) {
  const { t } = i18n;
  const prepare = opts.prepare ?? preparePhoto;
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

  // Photo: a hidden file input opened by the attach button (phones offer the camera too), a
  // preview with a remove button, and a status line screen readers announce.
  let photo: Photo | null = null;
  let preparing = false;
  const file = el('input', {
    type: 'file', accept: 'image/*', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true',
  });
  const attachBtn = button('icon-btn attach', '📷', () => file.click(), t('attachPhoto'));
  const thumb = el('img', { class: 'photo-thumb', alt: t('photoAlt') });
  const preview = el('div', { class: 'photo-preview', hidden: true },
    thumb,
    el('span', { class: 'muted' }, t('photoNotice')),
    button('icon-btn', '✕', () => clearPhoto(true), t('removePhoto')),
  );
  // One status line for photo and voice progress, announced to screen readers.
  const status = el('div', { class: 'count', role: 'status' });

  // Voice: a toggle mic button. While listening the input shows the words as they come and is
  // read-only, so typing can't clash with them; it's editable again when listening stops.
  const Voice = opts.voice ?? null;
  let dictation: Dictation | null = null;
  let quiet = false; // stopped by the widget, not the shopper: don't move focus
  // Whether the text in the box came (at least partly) from dictation; sent as via: 'voice'.
  let dictated = false;
  const micBtn = button('icon-btn mic', '🎤', () => (dictation ? dictation.stop() : listen()), t('voiceInput'));
  micBtn.setAttribute('aria-pressed', 'false');
  const hint = el('div', { class: 'count voice-hint', hidden: true }, t('voiceHint'));

  const classes = ['composer', opts.photos && 'with-photos', Voice && 'with-voice'].filter(Boolean);
  const form = el('form', { class: classes.join(' ') },
    opts.photos && preview,
    el('label', { for: 'shopchat-input', class: 'sr-only' }, t('inputLabel')),
    opts.photos && attachBtn,
    opts.photos && file,
    input,
    Voice && micBtn,
    send,
    count,
    (opts.photos || Voice) && status,
    Voice && hint,
  );

  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden';
    const left = maxChars - input.value.length;
    count.textContent = left <= 200 ? t('charsLeft', { n: left }) : '';
  };

  function clearPhoto(revoke: boolean): void {
    if (photo && revoke) URL.revokeObjectURL(photo.url);
    photo = null;
    preview.hidden = true;
    thumb.removeAttribute('src');
  }

  async function attach(blob: Blob): Promise<void> {
    if (!opts.photos || preparing || attachBtn.disabled) return;
    preparing = true;
    status.textContent = t('preparingPhoto');
    try {
      const ready = await prepare(blob);
      clearPhoto(true);
      photo = ready;
      thumb.src = ready.url;
      preview.hidden = false;
      status.textContent = t('photoReady');
      input.focus();
    } catch (err) {
      status.textContent = t(err instanceof PhotoError ? err.problem : 'errPhotoRead');
    } finally {
      preparing = false;
    }
  }

  const HINT_KEY = 'shopchat:voicehint';
  function listen(): void {
    if (!Voice || dictation) return;
    // What's already typed stays; dictated words go after it.
    const before = input.value.replace(/\s+$/, '');
    const prefix = before ? `${before} ` : '';
    input.readOnly = true;
    micBtn.setAttribute('aria-pressed', 'true');
    micBtn.classList.add('listening');
    status.textContent = t('listening');
    try {
      if (!localStorage.getItem(HINT_KEY)) {
        hint.hidden = false; // the first time only: say who turns speech into text
        localStorage.setItem(HINT_KEY, '1');
      }
    } catch {
      hint.hidden = false; // storage blocked: show it every time rather than never
    }
    dictation = startDictation(Voice, speechLang(i18n.locale), {
      onText(final, interim) {
        if (final || interim) dictated = true;
        input.value = (prefix + final + interim).slice(0, maxChars);
        resize();
      },
      onEnd(problem) {
        dictation = null;
        input.readOnly = false;
        micBtn.setAttribute('aria-pressed', 'false');
        micBtn.classList.remove('listening');
        status.textContent = problem ? t(problem) : input.value.trim() ? t('voiceDone') : '';
        if (quiet) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      },
    });
  }

  const submit = () => {
    if (dictation) {
      dictation.stop(); // Enter while listening ends dictation; the shopper sends after checking
      return;
    }
    if (send.disabled || preparing || (!input.value.trim() && !photo)) return;
    onSend(input.value, photo ?? undefined, dictated ? 'voice' : undefined);
    dictated = false;
    clearPhoto(false); // the sent bubble shows it now
    status.textContent = '';
    hint.hidden = true;
    input.value = '';
    resize();
  };

  const imageIn = (files: FileList | null | undefined) =>
    [...(files ?? [])].find((f) => f.type.startsWith('image/'));

  function stopVoice(): void {
    quiet = true;
    dictation?.abort();
    quiet = false;
  }
  // A hidden tab shouldn't keep the mic open.
  if (Voice) document.addEventListener('visibilitychange', () => document.hidden && stopVoice());

  input.addEventListener('input', () => {
    if (!input.value.trim()) dictated = false; // cleared and retyped: a typed message
    resize();
  });
  input.style.overflowY = 'hidden';
  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter adds a line; never while an IME is composing.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('paste', (e) => {
    const pasted = opts.photos && imageIn(e.clipboardData?.files);
    if (pasted) {
      e.preventDefault();
      void attach(pasted);
    }
  });
  file.addEventListener('change', () => {
    const picked = imageIn(file.files);
    file.value = ''; // picking the same file again still fires change
    if (picked) void attach(picked);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  return {
    element: form,
    focus: () => input.focus(),
    /** Stops listening at once (panel closed); keeps the words heard so far. */
    stopVoice,
    setBusy(busy: boolean) {
      send.disabled = busy;
      attachBtn.disabled = busy;
    },
    /** Lets a photo be dropped anywhere on `target` (the chat panel). */
    acceptDrops(target: HTMLElement) {
      if (!opts.photos) return;
      target.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
      });
      target.addEventListener('drop', (e) => {
        const dropped = imageIn(e.dataTransfer?.files);
        if (!dropped) return;
        e.preventDefault();
        void attach(dropped);
      });
    },
  };
}
