// Voice dictation (PLAN-21 M2): the browser's own speech recognition turns speech into text in
// the input box; the shopper checks it and presses Send. We never receive audio: depending on the
// browser, its maker's speech service does the work. Text arrives live while the shopper talks
// (interim results) and settles when they stop; browsers without interim results give it at the end.
//
// It keeps listening through pauses until the shopper stops it (like Claude's mic). Browsers end a
// recognition session on their own (Chrome after some silence or about a minute, Chrome on Android
// after each phrase), so a session that ends unasked is restarted and its text carried over.

/** About the 2,000-character message cap at normal speaking speed. */
export const VOICE_LIMIT_MS = 120_000;
// Sessions that end this soon after starting, this many times running: the recognizer can't run.
const QUICK_END_MS = 1000;
const MAX_QUICK_ENDS = 3;
// "No speech" sessions in a row, with nothing heard at all, before giving up (each is ~8 s).
const MAX_SILENT_SESSIONS = 2;

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
  /** All final text so far (across sessions), plus the words still being recognised. */
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

/** `a` and `b` with one space between them, unless one side already has it. */
function join(a: string, b: string): string {
  return a && b && !/\s$/.test(a) && !/^\s/.test(b) ? `${a} ${b}` : a + b;
}

export function startDictation(
  Ctor: RecognitionCtor,
  lang: string,
  handlers: DictationHandlers,
  limitMs = VOICE_LIMIT_MS,
  now: () => number = Date.now,
): Dictation {
  let rec: Recognition;
  let committed = ''; // final text from sessions that already ended
  let sessionFinal = '';
  let problem: VoiceProblem | null = null;
  let stopping = false; // the shopper (or the limit) asked to stop
  let ended = false;
  let heard = false;
  let silentSessions = 0;
  let quickEnds = 0;
  let startedAt = 0;

  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(limit);
    handlers.onEnd(problem);
  };

  function begin(): void {
    rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = true; // through pauses; ignored by some browsers, hence the restarts
    rec.maxAlternatives = 1;
    sessionFinal = '';
    startedAt = now();
    let silent = false;

    // Rebuilt from the session's whole list each time rather than added up from resultIndex: some
    // browsers (Chrome on Android) send finished results again, which would double the text.
    rec.onresult = (e) => {
      let final = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      sessionFinal = final;
      if (final || interim) heard = true;
      const done = join(committed, final);
      handlers.onText(done, done && interim && !/^\s/.test(interim) && !/\s$/.test(done)
        ? ` ${interim}` : interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech') {
        silent = true; // a pause: the next session carries on
        return;
      }
      problem ??= voiceProblem(e.error);
      if (problem) stopping = true;
    };
    rec.onend = () => {
      committed = join(committed, sessionFinal);
      sessionFinal = '';
      if (stopping) return finish();
      silentSessions = silent && !heard ? silentSessions + 1 : 0;
      if (silentSessions >= MAX_SILENT_SESSIONS) {
        problem = 'errMicNoSpeech';
        return finish();
      }
      // Ending on silence is normal; ending at once, without a reason, is a recognizer that can't run.
      quickEnds = !silent && now() - startedAt < QUICK_END_MS ? quickEnds + 1 : 0;
      if (quickEnds >= MAX_QUICK_ENDS) {
        problem = 'errMicUnavailable';
        return finish();
      }
      begin(); // the browser ended the session, not the shopper: keep listening
    };

    try {
      rec.start();
    } catch {
      problem ??= 'errMicUnavailable';
      stopping = true;
      finish();
    }
  }

  const stop = () => {
    stopping = true;
    rec.stop();
  };
  const limit = setTimeout(stop, limitMs);
  begin();
  return {
    stop,
    abort: () => {
      stopping = true;
      rec.abort();
      finish(); // some browsers fire no end event after abort
    },
  };
}
