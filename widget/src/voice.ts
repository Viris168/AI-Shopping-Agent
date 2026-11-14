// Voice dictation (PLAN-21 M2): the browser's own speech recognition turns speech into text in
// the input box; the shopper checks it and presses Send. We never receive audio: depending on the
// browser, its maker's speech service does the work. Text arrives live while the shopper talks
// (interim results) and settles when they stop; browsers without interim results give it at the end.

export const VOICE_LIMIT_MS = 60_000;

/** Why dictation stopped early, as an i18n key. */
export type VoiceProblem = 'errMicDenied' | 'errMicNoSpeech' | 'errMicUnavailable';

// lib.dom has no Web Speech types; only what we use.
interface Alternative { transcript: string }
interface Result { isFinal: boolean; length: number; [i: number]: Alternative }
interface ResultEvent { results: { length: number; [i: number]: Result } }

export interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export type RecognitionCtor = new () => Recognition;

/** The browser's recognizer, or null where there is none (Firefox): then no mic button. */
export function recognitionCtor(win: object = globalThis): RecognitionCtor | null {
  const w = win as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const LANGS: Record<string, string> = { en: 'en-US', vi: 'vi-VN' };

export function speechLang(locale: string): string {
  return LANGS[locale] ?? locale;
}

export function voiceProblem(error: string): VoiceProblem | null {
  switch (error) {
    case 'aborted':
      return null; // we stopped it
    case 'not-allowed':
    case 'service-not-allowed':
      return 'errMicDenied';
    case 'no-speech':
      return 'errMicNoSpeech';
    default:
      return 'errMicUnavailable'; // audio-capture, network, language-not-supported, …
  }
}

export interface DictationHandlers {
  /** All final text so far, plus the words still being recognised. */
  onText(final: string, interim: string): void;
  /** Recognition ended; `problem` when it failed, null when it stopped normally. */
  onEnd(problem: VoiceProblem | null): void;
}

export interface Dictation {
  /** Stop listening and keep what was heard. */
  stop(): void;
  /** Stop listening now (panel closed, page hidden). */
  abort(): void;
}

export function startDictation(
  Ctor: RecognitionCtor,
  lang: string,
  handlers: DictationHandlers,
  limitMs = VOICE_LIMIT_MS,
): Dictation {
  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false; // stops after a pause, like a sent message
  rec.maxAlternatives = 1;

  let problem: VoiceProblem | null = null;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(limit);
    handlers.onEnd(problem);
  };
  const limit = setTimeout(() => rec.stop(), limitMs);

  // Rebuilt from the whole list each time rather than added up from resultIndex: some browsers
  // (Chrome on Android) send finished results again, which would double the text.
  rec.onresult = (e) => {
    let final = '';
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    handlers.onText(final, interim);
  };
  rec.onerror = (e) => {
    problem ??= voiceProblem(e.error);
  };
  rec.onend = finish;

  try {
    rec.start();
  } catch {
    problem = 'errMicUnavailable';
    finish();
  }
  return {
    stop: () => rec.stop(),
    abort: () => {
      rec.abort();
      finish(); // some browsers fire no end event after abort
    },
  };
}
