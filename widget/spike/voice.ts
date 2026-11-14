// PLAN-21 M0 spike page: record each phrase with the browser's speech recognition, grade it, and
// export the results per browser. Dev-only (npm run dev → /spike/voice.html); not in the bundle.

import { PHRASES, type Phrase } from './phrases';
import { score, type Grade } from './score';

// lib.dom has no Web Speech types; just what the spike uses.
interface Alternative { transcript: string }
interface Result { isFinal: boolean; length: number; [i: number]: Alternative }
interface ResultEvent extends Event { resultIndex: number; results: { length: number; [i: number]: Result } }
interface ErrorEvent extends Event { error: string; message?: string }
interface Recognition extends EventTarget {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
}
type RecognitionCtor = (new () => Recognition) & { available?: unknown };

interface Run {
  id: string;
  lang: string;
  heard: string;
  grade: Grade | null;
  /** Grade the tester set by hand, if they disagreed with the automatic one. */
  override: Grade | null;
  missed: string[];
  wer: number | null;
  error: string | null;
  interimSeen: boolean;
  /** ms from Record to the first text. */
  firstTextMs: number | null;
  /** ms from the end of speech to the final text. */
  finalAfterSpeechMs: number | null;
  at: string;
}

const STORE_KEY = 'voice-spike:results';
const DEVICE_KEY = 'voice-spike:device';
const LIMIT_MS = 60_000; // PLAN-21 time limit

const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    /* private mode: results live until reload */
  }
}

const runs: Record<string, Run> = load(STORE_KEY, {});
let active: { phrase: Phrase; rec: Recognition; button: HTMLButtonElement } | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function status(text: string) {
  $('status').textContent = text;
}

function renderSupport() {
  const items = [
    `Speech recognition: ${Ctor ? (w.SpeechRecognition ? 'yes' : 'yes (webkit prefix)') : 'NOT SUPPORTED'}`,
    `Secure context (needed for the mic): ${window.isSecureContext ? 'yes' : 'NO — use localhost or HTTPS'}`,
    `On-device API (SpeechRecognition.available): ${Ctor && typeof Ctor.available === 'function' ? 'present' : 'absent'}`,
    `User agent: ${navigator.userAgent}`,
  ];
  $('support').replaceChildren(...items.map((t) => el('li', t)));
}

function finalGrade(r: Run): Grade | null {
  return r.override ?? r.grade;
}

function renderRows() {
  const filter = ($('filter') as HTMLSelectElement).value;
  const rows = PHRASES.filter((p) => filter === 'all' || p.lang === filter).map((p) => {
    const r = runs[p.id];
    const tr = el('tr');
    tr.id = `row-${p.id}`;

    const say = el('td');
    say.append(el('div', p.text, 'say'), el('div', `${p.id} · ${p.lang}`, 'muted'));

    const act = el('td');
    const button = el('button', 'Record');
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `Record ${p.id}`);
    button.disabled = !Ctor || (active !== null && active.phrase.id !== p.id);
    button.onclick = () => (active?.phrase.id === p.id ? active.rec.stop() : record(p, button));
    act.append(button);

    const heard = el('td');
    heard.id = `heard-${p.id}`;
    if (r?.error) heard.append(el('div', `Error: ${r.error}`, 'err'));
    if (r?.heard) heard.append(el('div', r.heard));
    if (r?.missed.length) heard.append(el('div', `Missed: ${r.missed.join(', ')}`, 'muted'));

    const grade = el('td');
    if (r && !r.error) {
      const g = finalGrade(r);
      const sel = el('select');
      sel.setAttribute('aria-label', `Grade for ${p.id}`);
      for (const v of ['exact', 'close', 'wrong'] as Grade[]) {
        const o = el('option', v + (v === r.grade ? ' (auto)' : ''));
        o.value = v;
        o.selected = v === g;
        sel.append(o);
      }
      sel.className = g ?? '';
      sel.onchange = () => {
        r.override = sel.value === r.grade ? null : (sel.value as Grade);
        save(STORE_KEY, runs);
        renderAll();
      };
      grade.append(sel);
      if (r.wer !== null) grade.append(el('div', `WER ${Math.round(r.wer * 100)}%`, 'muted'));
    }

    const timing = el('td', '', 'hide-sm muted');
    if (r && !r.error) {
      timing.textContent = [
        r.firstTextMs !== null ? `first text ${r.firstTextMs} ms` : null,
        r.finalAfterSpeechMs !== null ? `final ${r.finalAfterSpeechMs} ms after speech` : null,
        r.interimSeen ? 'live text: yes' : 'live text: no',
      ].filter(Boolean).join(' · ');
    }

    tr.append(say, act, heard, grade, timing);
    return tr;
  });
  $('rows').replaceChildren(...rows);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function renderSummary() {
  const table = el('table');
  const head = el('tr');
  for (const h of ['Language', 'Done', 'Exact', 'Close', 'Wrong', 'Errors', 'Median final latency']) head.append(el('th', h));
  table.append(head);
  for (const lang of ['en-US', 'vi-VN']) {
    const done = PHRASES.filter((p) => p.lang === lang).map((p) => runs[p.id]).filter(Boolean);
    const count = (g: Grade) => done.filter((r) => !r.error && finalGrade(r) === g).length;
    const lat = median(done.map((r) => r.finalAfterSpeechMs).filter((x): x is number => x !== null));
    const tr = el('tr');
    for (const v of [lang, `${done.length}/10`, count('exact'), count('close'), count('wrong'),
      done.filter((r) => r.error).length, lat === null ? '–' : `${lat} ms`]) tr.append(el('td', String(v)));
    table.append(tr);
  }
  $('summary').replaceChildren(table);
}

function renderAll() {
  renderRows();
  renderSummary();
}

function record(phrase: Phrase, button: HTMLButtonElement) {
  if (!Ctor) return;
  const rec = new Ctor();
  rec.lang = phrase.lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  const started = performance.now();
  let speechEnd: number | null = null;
  let firstText: number | null = null;
  let finalAt: number | null = null;
  let finalText = '';
  let interimSeen = false;
  let error: string | null = null;
  const limit = setTimeout(() => rec.stop(), LIMIT_MS);

  rec.onspeechend = () => (speechEnd = performance.now());
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        finalText += res[0].transcript;
        finalAt = performance.now();
      } else {
        interim += res[0].transcript;
        interimSeen = true;
      }
    }
    firstText ??= performance.now();
    const cell = document.getElementById(`heard-${phrase.id}`);
    if (cell) cell.replaceChildren(el('div', finalText), el('div', interim, 'interim'));
  };
  rec.onerror = (e) => (error = e.error || 'unknown');
  rec.onend = () => {
    clearTimeout(limit);
    active = null;
    const heard = finalText.trim();
    const s = heard && !error ? score(phrase, heard) : null;
    runs[phrase.id] = {
      id: phrase.id,
      lang: phrase.lang,
      heard,
      grade: s?.grade ?? null,
      override: null,
      missed: s?.missed ?? [],
      wer: s?.wer ?? null,
      error: error ?? (heard ? null : 'no-text'),
      interimSeen,
      firstTextMs: firstText === null ? null : Math.round(firstText - started),
      finalAfterSpeechMs: finalAt !== null && speechEnd !== null ? Math.max(0, Math.round(finalAt - speechEnd)) : null,
      at: new Date().toISOString(),
    };
    save(STORE_KEY, runs);
    status(s ? `${phrase.id}: ${s.grade}` : `${phrase.id}: ${runs[phrase.id].error}`);
    renderAll();
  };

  active = { phrase, rec, button };
  try {
    rec.start();
  } catch (e) {
    active = null;
    clearTimeout(limit);
    status(`Could not start: ${(e as Error).message}`);
    return;
  }
  renderRows();
  const b = document.querySelector<HTMLButtonElement>(`#row-${phrase.id} button`);
  if (b) {
    b.textContent = 'Stop';
    b.setAttribute('aria-pressed', 'true');
    b.focus();
  }
  status(`Listening for ${phrase.id}… speak now`);
}

function report() {
  return {
    plan: 'PLAN-21 M0',
    device: ($('device') as HTMLInputElement).value.trim() || null,
    userAgent: navigator.userAgent,
    supported: Boolean(Ctor),
    prefixed: Boolean(Ctor && !w.SpeechRecognition),
    onDeviceApi: Boolean(Ctor && typeof Ctor.available === 'function'),
    exportedAt: new Date().toISOString(),
    runs: PHRASES.map((p) => runs[p.id]).filter(Boolean),
  };
}

const device = $('device') as HTMLInputElement;
device.value = load(DEVICE_KEY, '');
device.oninput = () => save(DEVICE_KEY, JSON.stringify(device.value));
$('filter').onchange = renderRows;
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `voice-spike-${(device.value || 'browser').replace(/[^\w-]+/g, '-').toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(report(), null, 2));
    status('Results copied');
  } catch {
    status('Copy failed; use Download');
  }
};
$('clear').onclick = () => {
  if (!confirm('Clear all results in this browser?')) return;
  for (const k of Object.keys(runs)) delete runs[k];
  save(STORE_KEY, runs);
  renderAll();
};

renderSupport();
renderAll();
if (!Ctor) status('This browser has no speech recognition; the mic button would be hidden here.');
