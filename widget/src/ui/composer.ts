import type { I18n } from '../i18n';
import { type Photo, PhotoError, preparePhoto } from '../photo';
import { el } from '../safe';
import { button } from '../cards/product';

export function createComposer(
  i18n: I18n,
  maxChars: number,
  onSend: (text: string, photo?: Photo) => void,
  /** `photos`: show the attach button (agent-service /v1/config imagesEnabled). */
  opts: { photos: boolean; prepare?: (file: Blob) => Promise<Photo> } = { photos: false },
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
  const photoStatus = el('div', { class: 'count', role: 'status' });

  const form = el('form', { class: `composer${opts.photos ? ' with-photos' : ''}` },
    opts.photos && preview,
    el('label', { for: 'shopchat-input', class: 'sr-only' }, t('inputLabel')),
    opts.photos && attachBtn,
    opts.photos && file,
    input,
    send,
    count,
    opts.photos && photoStatus,
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
    photoStatus.textContent = t('preparingPhoto');
    try {
      const ready = await prepare(blob);
      clearPhoto(true);
      photo = ready;
      thumb.src = ready.url;
      preview.hidden = false;
      photoStatus.textContent = t('photoReady');
      input.focus();
    } catch (err) {
      photoStatus.textContent = t(err instanceof PhotoError ? err.problem : 'errPhotoRead');
    } finally {
      preparing = false;
    }
  }

  const submit = () => {
    if (send.disabled || preparing || (!input.value.trim() && !photo)) return;
    onSend(input.value, photo ?? undefined);
    clearPhoto(false); // the sent bubble shows it now
    photoStatus.textContent = '';
    input.value = '';
    resize();
  };

  const imageIn = (files: FileList | null | undefined) =>
    [...(files ?? [])].find((f) => f.type.startsWith('image/'));

  input.addEventListener('input', resize);
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
