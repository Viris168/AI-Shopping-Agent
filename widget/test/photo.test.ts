import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatApi } from '../src/api';
import { Controller } from '../src/controller';
import { createI18n } from '../src/i18n';
import { type Codec, MAX_UPLOAD_BYTES, type Photo, PhotoError, fitSize, preparePhoto } from '../src/photo';
import { Store } from '../src/state';
import { createComposer } from '../src/ui/composer';
import { MemoryStorage, jsonResponse, mockFetch, sse, sseResponse } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const PHOTO: Photo = { mediaType: 'image/jpeg', data: 'AAAA', url: 'blob:https://shop.test/1' };
const bodyOf = (fetch: ReturnType<typeof mockFetch>, call = 0) =>
  JSON.parse((fetch.mock.calls[call] as unknown as [string, RequestInit])[1].body as string);

function fakeCodec(sizes: number[], decodeFails = false) {
  const encoded: { width: number; height: number; quality: number }[] = [];
  const close = vi.fn();
  const codec: Codec = {
    decode: async () => {
      if (decodeFails) throw new Error('bad file');
      return { width: 4000, height: 3000, source: { close } as unknown as CanvasImageSource };
    },
    encode: async (_s, width, height, quality) => {
      encoded.push({ width, height, quality });
      return new Blob([new Uint8Array(sizes[encoded.length - 1] ?? 10)], { type: 'image/jpeg' });
    },
  };
  return { codec, encoded, close };
}

const file = (type = 'image/png', size = 1000) => new Blob([new Uint8Array(size)], { type });

describe('preparePhoto', () => {
  it('fits photos inside the long edge without enlarging small ones', () => {
    expect(fitSize(4000, 3000)).toEqual([1568, 1176]);
    expect(fitSize(600, 800)).toEqual([600, 800]);
  });

  it('shrinks, re-encodes as JPEG and frees the decoded bitmap', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x' }));
    const { codec, encoded, close } = fakeCodec([500]);
    const photo = await preparePhoto(file(), codec);
    expect(encoded).toEqual([{ width: 1568, height: 1176, quality: 0.85 }]);
    expect(photo.mediaType).toBe('image/jpeg');
    expect(photo.data).toBe(btoa('\0'.repeat(500)));
    expect(photo.url).toBe('blob:x');
    expect(close).toHaveBeenCalled();
  });

  it('lowers the quality until the photo fits the upload limit', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x' }));
    const { codec, encoded } = fakeCodec([MAX_UPLOAD_BYTES + 1, 900]);
    await preparePhoto(file(), codec);
    expect(encoded.map((e) => e.quality)).toEqual([0.85, 0.7]);
  });

  it('says why a photo was refused', async () => {
    const problem = (p: Promise<unknown>) => p.catch((e: PhotoError) => e.problem);
    expect(await problem(preparePhoto(file('application/pdf'), fakeCodec([1]).codec))).toBe('errPhotoRead');
    expect(await problem(preparePhoto(file(), fakeCodec([1], true).codec))).toBe('errPhotoRead');
    const huge = fakeCodec([MAX_UPLOAD_BYTES + 1, MAX_UPLOAD_BYTES + 1, MAX_UPLOAD_BYTES + 1]);
    expect(await problem(preparePhoto(file(), huge.codec))).toBe('errPhotoTooBig');
    expect(huge.close).toHaveBeenCalled();
  });
});

function setup() {
  const store = new Store('k', null);
  const controller = new Controller(store, new ChatApi('https://chat.test', () => null, 0), createI18n('en'), {
    maxChars: 2000,
    onCartUpdated: vi.fn(),
    announce: vi.fn(),
  });
  return { store, controller };
}

const reply = () => sseResponse(sse(['meta', { conversationId: 'c1', messageId: 's1' }], ['text_delta', { text: 'ok' }]));
const photoRefused = (status: number) =>
  new Response(JSON.stringify({ detail: 'no' }), { status, headers: { 'X-Limit': 'images' } });

describe('Controller with photos', () => {
  it('sends the photo with the message and shows it in the bubble', async () => {
    const fetch = mockFetch(reply());
    const { store, controller } = setup();
    await controller.send('is this mine?', PHOTO);
    expect(bodyOf(fetch).image).toEqual({ mediaType: 'image/jpeg', data: 'AAAA' });
    expect(store.state.messages[0]).toMatchObject({ role: 'user', text: 'is this mine?', photo: { url: PHOTO.url } });
  });

  it('sends a photo without words, but not an empty message', async () => {
    const fetch = mockFetch(reply());
    const { controller } = setup();
    await controller.send('   ');
    await controller.send('', PHOTO);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetch).message).toBe('');
  });

  it('resends the photo on Try again', async () => {
    const fetch = mockFetch(jsonResponse(500), reply());
    const { store, controller } = setup();
    await controller.send('', PHOTO);
    await controller.retry(store.state.messages[1].id);
    expect(bodyOf(fetch, 1).image.data).toBe('AAAA');
  });

  it("treats a refused photo as a photo problem, not a login change or rate limit", async () => {
    const fetch = mockFetch(photoRefused(403), photoRefused(429));
    const { store, controller } = setup();
    store.set({ conversationId: 'c1' });
    await controller.send('look', PHOTO);
    expect(fetch).toHaveBeenCalledTimes(1); // no fresh-conversation retry
    expect(store.state.conversationId).toBe('c1');
    expect(store.state.messages[1].error).toEqual({ message: createI18n('en').t('errPhotoOff'), retryable: false });
    await controller.send('again', PHOTO);
    expect(store.state.messages[3].error?.message).toContain('as many photos');
  });

  it("keeps the photo out of sessionStorage", () => {
    const storage = new MemoryStorage();
    const store = new Store('k', storage);
    store.add({ id: 'm1', role: 'user', text: '', cards: [], status: 'done', photo: { url: PHOTO.url } });
    expect(storage.getItem('k')).not.toContain('blob:');
    expect(new Store('k', storage).state.messages[0].photo).toEqual({});
  });
});

describe('composer with photos', () => {
  const i18n = createI18n('en');

  function composer(prepare: (f: Blob) => Promise<Photo>, photos = true) {
    const onSend = vi.fn();
    const c = createComposer(i18n, 2000, onSend, { photos, prepare });
    document.body.append(c.element);
    const q = <T extends Element>(sel: string) => c.element.querySelector<T>(sel);
    const pick = async (f: Blob) => {
      const input = q<HTMLInputElement>('input[type=file]')!;
      Object.defineProperty(input, 'files', { value: [f], configurable: true });
      input.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(q('[role=status]')!.textContent).not.toBe(i18n.t('preparingPhoto')));
    };
    return { c, onSend, q, pick };
  }

  it('has no attach button when photos are off', () => {
    const { q } = composer(async () => PHOTO, false);
    expect(q('.attach')).toBeNull();
    expect(q('input[type=file]')).toBeNull();
  });

  it('attaches, previews and sends a photo, with labels for screen readers', async () => {
    const { q, pick, onSend } = composer(async () => PHOTO);
    expect(q('.attach')!.getAttribute('aria-label')).toBe('Add a photo');
    await pick(new File(['x'], 'p.png', { type: 'image/png' }));
    expect(q<HTMLElement>('.photo-preview')!.hidden).toBe(false);
    expect(q<HTMLImageElement>('.photo-thumb')!.getAttribute('alt')).toBe('Your photo');
    expect(q('[role=status]')!.textContent).toBe('Photo attached');
    q<HTMLElement>('.send')!.closest('form')!.dispatchEvent(new Event('submit'));
    expect(onSend).toHaveBeenCalledWith('', PHOTO);
    expect(q<HTMLElement>('.photo-preview')!.hidden).toBe(true);
  });

  it('removes an attached photo', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: revoke }));
    const { q, pick, onSend } = composer(async () => PHOTO);
    await pick(new File(['x'], 'p.png', { type: 'image/png' }));
    q<HTMLButtonElement>('[aria-label="Remove photo"]')!.click();
    expect(q<HTMLElement>('.photo-preview')!.hidden).toBe(true);
    expect(revoke).toHaveBeenCalledWith(PHOTO.url);
    q<HTMLElement>('.send')!.closest('form')!.dispatchEvent(new Event('submit'));
    expect(onSend).not.toHaveBeenCalled(); // nothing left to send
  });

  it('says why a photo was refused', async () => {
    const { q, pick } = composer(async () => {
      throw new PhotoError('errPhotoTooBig');
    });
    await pick(new File(['x'], 'p.png', { type: 'image/png' }));
    expect(q('[role=status]')!.textContent).toBe(i18n.t('errPhotoTooBig'));
    expect(q<HTMLElement>('.photo-preview')!.hidden).toBe(true);
  });
});
