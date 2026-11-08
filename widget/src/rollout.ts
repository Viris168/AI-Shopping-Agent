// Rollout flag and kill switch (ARCHITECTURE.md §7, §12). agent-service's GET /v1/config says
// whether the assistant is on and what share of shoppers see it; the widget mounts only if both
// allow it. Each browser keeps a fixed bucket 0–99, so a shopper doesn't see the bubble come and
// go between pages, and raising the percentage only ever adds shoppers.
//
// Staff preview before the rollout reaches them: open any page with ?shopchat=on (?shopchat=off
// to undo). The kill switch still wins.

const BUCKET_KEY = 'shopchat:bucket';
const OPT_IN_KEY = 'shopchat:optin';

export interface RolloutConfig {
  enabled: boolean;
  rolloutPercent: number;
}

export async function fetchConfig(apiBase: string): Promise<RolloutConfig | null> {
  try {
    const res = await fetch(`${apiBase}/v1/config`, { credentials: 'omit' });
    if (!res.ok) return null;
    const body = await res.json();
    return { enabled: body?.enabled === true, rolloutPercent: Number(body?.rolloutPercent) || 0 };
  } catch {
    return null;
  }
}

/** Fails closed: no config (agent-service down) means no bubble, rather than a broken chat. */
export function shouldMount(
  config: RolloutConfig | null,
  search: string,
  storage: Storage | null = safeLocalStorage(),
  random: () => number = Math.random,
): boolean {
  if (!config?.enabled) return false;
  const param = new URLSearchParams(search).get('shopchat');
  try {
    if (param === 'on') storage?.setItem(OPT_IN_KEY, '1');
    if (param === 'off') storage?.removeItem(OPT_IN_KEY);
    if (storage?.getItem(OPT_IN_KEY) === '1') return true;
  } catch {
    // Storage blocked: no staff preview, the percentage still applies.
  }
  return bucket(storage, random) < config.rolloutPercent;
}

function bucket(storage: Storage | null, random: () => number): number {
  try {
    const saved = Number.parseInt(storage?.getItem(BUCKET_KEY) ?? '', 10);
    if (saved >= 0 && saved < 100) return saved;
    const fresh = Math.floor(random() * 100);
    storage?.setItem(BUCKET_KEY, String(fresh));
    return fresh;
  } catch {
    return Math.floor(random() * 100);
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
