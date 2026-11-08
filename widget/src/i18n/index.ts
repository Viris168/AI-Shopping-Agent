import en from './en.json';
import vi from './vi.json';

export type Strings = typeof en;
type StringKey = { [K in keyof Strings]: Strings[K] extends string ? K : never }[keyof Strings];

const LOCALES: Record<string, Strings> = { en, vi };

export interface I18n {
  locale: string;
  t(key: StringKey, vars?: Record<string, string | number>): string;
  chips: string[];
  status(code: unknown): string;
  date(iso: unknown): string;
  time(iso: unknown): string;
}

export function pickLocale(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    const base = c?.toLowerCase().split(/[-_]/)[0];
    if (base && base in LOCALES) return base;
  }
  return 'en';
}

export function createI18n(locale: string): I18n {
  const strings = LOCALES[locale] ?? en;
  const format = (fn: (d: Date) => string) => (iso: unknown) => {
    const d = typeof iso === 'string' ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? fn(d) : '';
  };
  return {
    locale,
    chips: strings.chips,
    t: (key, vars = {}) =>
      (strings[key] ?? en[key]).replace(/\{(\w+)\}/g, (m, name: string) =>
        name in vars ? String(vars[name]) : m,
      ),
    status: (code) => {
      const map = strings.status as Record<string, string>;
      return typeof code === 'string' ? (map[code] ?? code) : '';
    },
    date: format((d) => d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })),
    time: format((d) => d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })),
  };
}
