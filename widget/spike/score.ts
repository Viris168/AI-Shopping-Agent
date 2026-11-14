// PLAN-21 M0: grade what the browser heard against what the tester read.
//   exact – every key term came through (any accepted spelling, accents included)
//   close – every key term is there once accents, spaces and hyphens are ignored
//           ("dơn hang ORD 1 001"): readable, but the shopper would likely fix it
//   wrong – a key term is missing; the shopper would have to retype
// Word error rate over the whole phrase is reported alongside, for information.

import type { Phrase } from './phrases';

export type Grade = 'exact' | 'close' | 'wrong';

export interface Score {
  grade: Grade;
  /** First spelling of each key term that didn't come through even loosely. */
  missed: string[];
  /** Word error rate of the transcript against the phrase, 0 = perfect. */
  wer: number;
}

/** Lower case, punctuation to spaces, thousands separators dropped ("5.000.000" → "5000000"). */
export function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/(\d)[.,](?=\d{3}(\D|$))/g, '$1')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `normalize`, then no accents (đ → d) and no spaces. */
export function loosen(s: string): string {
  return normalize(s).normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/\s/g, '');
}

function hasWords(text: string, key: string): boolean {
  return ` ${text} `.includes(` ${normalize(key)} `);
}

export function wordErrorRate(expected: string, heard: string): number {
  const a = normalize(expected).split(' ').filter(Boolean);
  const b = normalize(heard).split(' ').filter(Boolean);
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length] / a.length;
}

export function score(phrase: Phrase, heard: string): Score {
  const strict = normalize(heard);
  const loose = loosen(heard);
  const exact = phrase.keys.every((alts) => alts.some((k) => hasWords(strict, k)));
  const missed = phrase.keys.filter((alts) => !alts.some((k) => loose.includes(loosen(k)))).map((alts) => alts[0]);
  const grade: Grade = exact ? 'exact' : missed.length === 0 ? 'close' : 'wrong';
  return { grade, missed, wer: wordErrorRate(phrase.text, heard) };
}
