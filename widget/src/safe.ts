// Every DOM node the widget creates goes through `el`, which only ever sets text and
// attributes. Nothing uses innerHTML, so model or API text can never become markup.

type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === undefined) continue;
    node.setAttribute(name, value === true ? '' : value);
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/** Links and images are allowed only on the store's own domains (plus any configured extras). */
export class LinkPolicy {
  private readonly domains: string[];

  constructor(domains: string[]) {
    this.domains = domains.map((d) => d.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
  }

  safeUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw) return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    const allowed = this.domains.some((d) => host === d || host.endsWith(`.${d}`));
    return allowed ? url.href : null;
  }
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/** Text with allowed URLs turned into links. Everything else stays plain text. */
export function linkify(text: string, policy: LinkPolicy): DocumentFragment {
  const out = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    // Trailing punctuation usually belongs to the sentence, not the URL.
    const raw = match[0].replace(/[.,;:!?)\]]+$/, '');
    const href = policy.safeUrl(raw);
    if (!href) continue;
    append(out, [text.slice(last, start)]);
    out.appendChild(el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, raw));
    last = start + raw.length;
  }
  append(out, [text.slice(last)]);
  return out;
}

export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
