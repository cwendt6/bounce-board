import type { Chain, Holder } from "./fake-data";

/** 0x7a3f9c21...1e2d3c -> 0x7a3f...2d3c */
export function shortAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const DEX_CHAIN: Record<Chain, string> = { base: "base", solana: "solana", ethereum: "ethereum" };

export function dexscreenerUrl(chain: Chain, contract: string): string {
  return `https://dexscreener.com/${DEX_CHAIN[chain]}/${encodeURIComponent(contract)}`;
}

/** What the box shows: $TICKER for tokens, otherwise the display name. */
export function boxLabel(h: Pick<Holder, "name" | "ticker">): string {
  return h.ticker ? `$${h.ticker}` : h.name;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}

/**
 * Split a label into two balanced lines for the box.
 * Prefers spaces, then camelCase or letter/digit boundaries (DegenCapitalVC -> Degen / CapitalVC),
 * then the middle of the word. Returns null for labels too short to split.
 */
export function splitLabel(text: string): [string, string] | null {
  const t = text.trim();
  if (t.length < 4) return null;
  const cuts: number[] = [];
  for (let i = 1; i < t.length; i++) {
    const a = t[i - 1];
    const b = t[i];
    if (b === " ") continue;
    if (a === " ") cuts.push(i);
  }
  if (!cuts.length) {
    for (let i = 1; i < t.length; i++) {
      const a = t[i - 1];
      const b = t[i];
      const lowerUpper = /[a-z]/.test(a) && /[A-Z]/.test(b);
      const letterDigit = /[A-Za-z]/.test(a) !== /[A-Za-z]/.test(b) && /[A-Za-z0-9]/.test(a + b);
      if (lowerUpper || letterDigit) cuts.push(i);
    }
  }
  const mid = t.length / 2;
  // The best cut keeps the longer line as short as possible.
  const longer = (i: number) => Math.max(t.slice(0, i).trim().length, t.slice(i).trim().length);
  let best = cuts.length ? cuts.reduce((x, y) => (longer(y) < longer(x) ? y : x)) : -1;
  // A cut that leaves one side tiny is worse than a clean break in the middle.
  if (best < 0 || Math.min(best, t.length - best) < t.length * 0.3) best = Math.ceil(mid);
  return [t.slice(0, best).trim(), t.slice(best).trim()];
}
