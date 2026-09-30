/**
 * Demo takeover schedule for milestone 1: the holders rotate on a fixed wall-clock cycle,
 * so every browser shows the same holder and the same box position without a server.
 * Milestone 2 replaces this with takeover events broadcast by the server.
 */
import { hashSeed } from "./rng";

export const DEMO_REIGN_SECONDS = 90;

export interface Reign {
  /** Index into the holder list. */
  holder: number;
  /** Takeover start, ms since epoch. */
  startMs: number;
  endMs: number;
  seed: number;
}

export function reignAt(nowMs: number, holderCount: number, reignSeconds = DEMO_REIGN_SECONDS) {
  const len = reignSeconds * 1000;
  const n = Math.floor(nowMs / len);
  const startMs = n * len;
  return {
    holder: ((n % holderCount) + holderCount) % holderCount,
    startMs,
    endMs: startMs + len,
    seed: hashSeed(`reign:${startMs}`),
  } satisfies Reign;
}

/** The next `count` reigns after the current one, for the queue sidebar. */
export function upcoming(
  nowMs: number,
  holderCount: number,
  count: number,
  reignSeconds = DEMO_REIGN_SECONDS,
) {
  const cur = reignAt(nowMs, holderCount, reignSeconds);
  const out: Reign[] = [];
  for (let i = 1; i <= count; i++)
    out.push(reignAt(cur.startMs + i * reignSeconds * 1000, holderCount, reignSeconds));
  return out;
}
