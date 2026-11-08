const STOPWORDS = new Set(
  'a an and are as at be by can do does for from have how i in is it me my of on or our show so some that the this to want we what when where which who will with you your'.split(
    ' ',
  ),
);
const MAX_TERMS = 8;

/** Naive singular: "boots" → "boot", "batteries" → "battery"; leaves "glass" alone. */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss'))
    return word.slice(0, -1);
  return word;
}

/** Search terms: lowercase letters/digits only, stopwords removed, singular, unique, at most 8. */
export function searchTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(singular);
  return [...new Set(words)].slice(0, MAX_TERMS);
}
