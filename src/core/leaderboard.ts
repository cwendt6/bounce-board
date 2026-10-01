/**
 * Leaderboards that include the reign in progress.
 *
 * The server only knows finished reigns between broadcasts. Corner hits are a pure function of
 * (seed, time), so every client can count the current holder's corners itself and merge them
 * in, and everyone still agrees.
 */
import { cornerHits, initialPhase } from "./motion";

export interface CornerTotal {
  key: string;
  label: string;
  corners: number;
}

export interface Reign {
  label: string;
  ms: number;
}

export interface LiveReign {
  key: string;
  label: string;
  startMs: number;
  seed: number;
  /** Corners this holder earned in earlier, finished reigns. */
  priorCorners: number;
}

export const TOP_N = 5;

/** One leaderboard identity per token ticker, or per name for brands. Shared with the server. */
export function holderKey(card: { name: string; ticker?: string }): string {
  return (card.ticker ? `$${card.ticker}` : card.name).toLowerCase();
}

export function holderLabel(card: { name: string; ticker?: string }): string {
  return card.ticker ? `$${card.ticker}` : card.name;
}

export function liveCorners(r: Pick<LiveReign, "startMs" | "seed">, nowMs: number): number {
  return cornerHits(initialPhase(r.seed), 0, Math.max(0, nowMs - r.startMs) / 1000).length;
}

export function mergeCornerClub(
  finished: CornerTotal[],
  live: LiveReign | null,
  nowMs: number,
): CornerTotal[] {
  const byKey = new Map(finished.map((c) => [c.key, { ...c }]));
  if (live) {
    const n = liveCorners(live, nowMs);
    if (n > 0)
      byKey.set(live.key, { key: live.key, label: live.label, corners: live.priorCorners + n });
  }
  return [...byKey.values()]
    .filter((c) => c.corners > 0)
    .sort((a, b) => b.corners - a.corners || a.label.localeCompare(b.label))
    .slice(0, TOP_N);
}

export function mergeLongest(finished: Reign[], live: LiveReign | null, nowMs: number): Reign[] {
  const all = [...finished];
  if (live) all.push({ label: live.label, ms: Math.max(0, nowMs - live.startMs) });
  return all.sort((a, b) => b.ms - a.ms).slice(0, TOP_N);
}
