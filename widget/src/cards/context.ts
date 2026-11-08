import type { I18n } from '../i18n';
import type { LinkPolicy } from '../safe';

export interface CardContext {
  i18n: I18n;
  links: LinkPolicy;
  send(text: string): void;
  confirm(actionId: string): void;
  cancel(actionId: string): void;
}

export const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
export const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
