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
