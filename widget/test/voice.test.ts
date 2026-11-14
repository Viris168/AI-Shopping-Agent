import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from '../src/i18n';
import { createComposer } from '../src/ui/composer';
import {
  type Recognition,
  type RecognitionCtor,
  recognitionCtor,
  speechLang,
  startDictation,
  voiceProblem,
} from '../src/voice';

/** A recognizer the test drives: `say` sends results, `end` ends the session, `fail` errors. */
class FakeRecognition implements Recognition {
  static last: FakeRecognition | null = null;
  static startThrows = false;
  lang = '';
  interimResults = false;
  continuous = true;
  maxAlternatives = 5;
  started = false;
  stopped = false;
  aborted = false;
  onresult: Recognition['onresult'] = null;
  onerror: Recognition['onerror'] = null;
  onend: Recognition['onend'] = null;

  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    if (FakeRecognition.startThrows) throw new Error('already started');
    this.started = true;
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  /** The browser ends the session by itself (a pause, its own time cap, Android per phrase). */
  end() {
    this.onend?.();
  }
  abort() {
    this.aborted = true;
  }
  /** The browser's whole result list so far; each [text, isFinal]. */
  say(...parts: [string, boolean][]) {
    const results = parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
    this.onresult?.({ results: results as never });
  }
  fail(error: string) {
    this.onerror?.({ error });
    this.onend?.();
  }
}
const Fake = FakeRecognition as unknown as RecognitionCtor;
const rec = () => FakeRecognition.last!;

beforeEach(() => {
  FakeRecognition.last = null;
  FakeRecognition.startThrows = false;
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe('voice', () => {
  it('finds the recognizer, prefixed or not, and none in Firefox', () => {
    expect(recognitionCtor({ SpeechRecognition: Fake })).toBe(Fake);
    expect(recognitionCtor({ webkitSpeechRecognition: Fake })).toBe(Fake);
    expect(recognitionCtor({})).toBeNull();
  });

  it("listens in the widget's language", () => {
    expect(speechLang('en')).toBe('en-US');
    expect(speechLang('vi')).toBe('vi-VN');
  });

  it('turns browser errors into messages, and ignores its own abort', () => {
    expect(voiceProblem('not-allowed')).toBe('errMicDenied');
    expect(voiceProblem('service-not-allowed')).toBe('errMicDenied');
    expect(voiceProblem('no-speech')).toBe('errMicNoSpeech');
    expect(voiceProblem('network')).toBe('errMicUnavailable');
    expect(voiceProblem('audio-capture')).toBe('errMicUnavailable');
    expect(voiceProblem('aborted')).toBeNull();
  });

  it('asks for live text, one result at a time, and passes final and pending words', () => {
    const onText = vi.fn();
    const onEnd = vi.fn();
    const d = startDictation(Fake, 'vi-VN', { onText, onEnd });
    expect(rec()).toMatchObject({ lang: 'vi-VN', interimResults: true, continuous: true, maxAlternatives: 1, started: true });

    rec().say(['where is', false]);
    expect(onText).toHaveBeenLastCalledWith('', 'where is');
    rec().say(['where is my order', true], [' ORD', false]);
    expect(onText).toHaveBeenLastCalledWith('where is my order', ' ORD');
    rec().say(['where is my order', true], [' ORD-1001', true]);
    expect(onText).toHaveBeenLastCalledWith('where is my order ORD-1001', '');
    rec().say(['where is my order', true], [' ORD-1001', true]); // sent again (Android)
    expect(onText).toHaveBeenLastCalledWith('where is my order ORD-1001', '');
    d.stop();
    expect(onEnd).toHaveBeenCalledWith(null);
  });

  it('keeps listening when the browser ends a session, carrying the text over', () => {
    const onText = vi.fn();
    const onEnd = vi.fn();
    const d = startDictation(Fake, 'en-US', { onText, onEnd });
    const first = rec();
    first.say(['where is my order', true]);
    first.end(); // a pause: the browser stops, the shopper didn't
    expect(onEnd).not.toHaveBeenCalled();
    expect(rec()).not.toBe(first);
    expect(rec().started).toBe(true);

    rec().say(['ORD', false]);
    expect(onText).toHaveBeenLastCalledWith('where is my order', ' ORD');
    rec().say(['ORD-1001', true]);
    expect(onText).toHaveBeenLastCalledWith('where is my order ORD-1001', '');
    d.stop();
    expect(onEnd).toHaveBeenCalledWith(null);
  });

  it('carries on through pauses, but gives up after long silence with nothing heard', () => {
    const onEnd = vi.fn();
    startDictation(Fake, 'en-US', { onText: vi.fn(), onEnd });
    rec().fail('no-speech');
    expect(onEnd).not.toHaveBeenCalled(); // one quiet stretch: keep listening
    rec().fail('no-speech');
    expect(onEnd).toHaveBeenCalledWith('errMicNoSpeech');

    const later = vi.fn();
    startDictation(Fake, 'en-US', { onText: vi.fn(), onEnd: later });
    rec().say(['hello', true]);
    rec().fail('no-speech');
    rec().fail('no-speech');
    rec().fail('no-speech');
    expect(later).not.toHaveBeenCalled(); // they did speak: silence is just a pause
  });

  it('gives up if the browser keeps ending sessions straight away', () => {
    let t = 0;
    const onEnd = vi.fn();
    startDictation(Fake, 'en-US', { onText: vi.fn(), onEnd }, 120_000, () => t);
    rec().end();
    rec().end();
    expect(onEnd).not.toHaveBeenCalled();
    rec().end();
    expect(onEnd).toHaveBeenCalledWith('errMicUnavailable');

    const fine = vi.fn();
    startDictation(Fake, 'en-US', { onText: vi.fn(), onEnd: fine }, 120_000, () => t);
    for (let i = 0; i < 5; i++) {
      t += 5000; // sessions of a few seconds each: normal
      rec().end();
    }
    expect(fine).not.toHaveBeenCalled();
  });

  it('stops by itself at the time limit', () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    startDictation(Fake, 'en-US', { onText: vi.fn(), onEnd }, 60_000);
    vi.advanceTimersByTime(59_999);
    expect(rec().stopped).toBe(false);
    vi.advanceTimersByTime(1);
    expect(rec().stopped).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('reports a failed start, and ends once on abort', () => {
    const onEnd = vi.fn();
    FakeRecognition.startThrows = true;
    startDictation(Fake, 'en-US', { onText: vi.fn(), onEnd });
    expect(onEnd).toHaveBeenCalledWith('errMicUnavailable');

    FakeRecognition.startThrows = false;
    const ended = vi.fn();
    const d = startDictation(Fake, 'en-US', { onText: vi.fn(), onEnd: ended });
    d.abort();
    rec().onend?.(); // a browser that does fire end after abort
    expect(rec().aborted).toBe(true);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe('composer with voice', () => {
  const i18n = createI18n('en');

  function composer(voice: RecognitionCtor | null = Fake, maxChars = 2000) {
    const onSend = vi.fn();
    const c = createComposer(i18n, maxChars, onSend, { photos: false, voice });
    document.body.append(c.element);
    const q = <T extends Element>(sel: string) => c.element.querySelector<T>(sel)!;
    const input = q<HTMLTextAreaElement>('textarea');
    const mic = () => q<HTMLButtonElement>('.mic');
    const status = () => q('[role=status]').textContent;
    const enter = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { c, onSend, q, input, mic, status, enter };
  }

  it('has no mic when voice is off or the browser has no recognizer', () => {
    const { c } = composer(null);
    expect(c.element.querySelector('.mic')).toBeNull();
    expect(c.element.classList.contains('with-voice')).toBe(false);
  });

  it('is a labelled toggle button for keyboards and screen readers', () => {
    const { mic, c } = composer();
    expect(mic().getAttribute('aria-label')).toBe('Speak your message');
    expect(mic().getAttribute('aria-pressed')).toBe('false');
    expect(mic().type).toBe('button');
    expect(c.element.classList.contains('with-voice')).toBe(true);
  });

  it('shows words live, keeps what was typed, and never sends by itself', () => {
    const { input, mic, status, onSend } = composer();
    input.value = 'Hi.  ';
    mic().click();
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    expect(input.readOnly).toBe(true);
    expect(status()).toBe('Listening…');

    rec().say(['where is my', false]);
    expect(input.value).toBe('Hi. where is my');
    rec().say(['where is my order', true]);
    rec().end(); // a pause doesn't stop it
    expect(input.readOnly).toBe(true);
    mic().click(); // the shopper does

    expect(input.value).toBe('Hi. where is my order');
    expect(input.readOnly).toBe(false);
    expect(mic().getAttribute('aria-pressed')).toBe('false');
    expect(status()).toBe('Stopped listening. Check the text, then send.');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('stops listening on Enter instead of sending, then sends on the next Enter', () => {
    const { mic, enter, onSend } = composer();
    mic().click();
    rec().say(['track my order', true]);
    enter();
    expect(rec().stopped).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    enter();
    expect(onSend).toHaveBeenCalledWith('track my order', undefined, 'voice');
  });

  it('sends dictated text as voice, and typed or cleared-and-retyped text as typed', () => {
    const { input, mic, enter, onSend } = composer();
    input.value = 'typed';
    enter();
    expect(onSend).toHaveBeenLastCalledWith('typed', undefined, undefined);

    mic().click();
    rec().say(['track my order', true]);
    mic().click();
    input.value += ' please'; // edited after dictating: still a voice message
    enter();
    expect(onSend).toHaveBeenLastCalledWith('track my order please', undefined, 'voice');

    input.value = 'next one'; // the box was emptied by sending: typed again
    enter();
    expect(onSend).toHaveBeenLastCalledWith('next one', undefined, undefined);

    mic().click();
    rec().say(['oops', true]);
    mic().click();
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.value = 'typed instead';
    enter();
    expect(onSend).toHaveBeenLastCalledWith('typed instead', undefined, undefined);
  });

  it('shows a recording bar with the time while listening', () => {
    vi.useFakeTimers();
    const { q, mic, status } = composer();
    const bar = q<HTMLElement>('.voice-bar');
    expect(bar.hidden).toBe(true);
    mic().click();
    expect(bar.hidden).toBe(false);
    expect(bar.getAttribute('aria-hidden')).toBe('true'); // no ticking clock for screen readers
    expect(q('.rec-time').textContent).toBe('0:00 / 2:00');
    vi.advanceTimersByTime(12_000);
    expect(q('.rec-time').textContent).toBe('0:12 / 2:00');
    expect(bar.textContent).toContain('Tap 🎤 or press Enter to stop');
    expect(status()).toBe('Listening…'); // still announced
    mic().click();
    expect(bar.hidden).toBe(true);
  });

  it('keeps dictated text within the character limit', () => {
    const { input, mic } = composer(Fake, 10);
    mic().click();
    rec().say(['a much longer sentence', true]);
    expect(input.value).toBe('a much lon');
  });

  it('says why the mic failed', () => {
    const { mic, status, input } = composer();
    mic().click();
    rec().fail('not-allowed');
    expect(status()).toBe('The microphone is blocked. Allow it in your browser settings, or type your question.');
    expect(input.readOnly).toBe(false);
  });

  it('shows who turns speech into text the first time only', () => {
    const first = composer();
    first.mic().click();
    expect(first.q<HTMLElement>('.voice-hint').hidden).toBe(false);
    expect(first.q('.voice-hint').textContent).toBe('Your browser turns speech into text. We never get the audio.');
    first.mic().click();

    const later = composer();
    later.mic().click();
    expect(later.q<HTMLElement>('.voice-hint').hidden).toBe(true);
  });

  it('stops at once when the panel closes or the tab is hidden, without moving focus', () => {
    const { c, mic, input } = composer();
    mic().click();
    rec().say(['hello', false]);
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    c.stopVoice();
    expect(rec().aborted).toBe(true);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe('hello');
    expect(document.activeElement).toBe(other);

    mic().click();
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(rec().aborted).toBe(true);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    other.remove();
  });
});
