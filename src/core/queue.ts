/**
 * Takeover queue rules, shared by the server (authoritative) and tests.
 *
 * - First paid, first shown.
 * - A holder keeps the box for at least MIN_HOLD_MS.
 * - Each corner hit protects the holder for CORNER_PROTECT_MS from the moment of the hit.
 * - With nobody queued, the holder keeps the box until the next buyer arrives.
 *
 * Everything here is a pure function of the inputs, so the same state always gives the same
 * schedule. The Durable Object calls `advance` on each payment and on each alarm.
 */
import { cornerHits, initialPhase } from "./motion";
import { hashSeed } from "./rng";

export const MIN_HOLD_MS = 60_000;
export const CORNER_PROTECT_MS = 60_000;

export interface Card {
  name: string;
  ticker?: string;
}

export interface Pending<C extends Card = Card> {
  /** Sale id; also seeds the takeover's path. */
  id: string;
  paidAtMs: number;
  card: C;
}

export interface Takeover<C extends Card = Card> extends Pending<C> {
  startMs: number;
  seed: number;
}

export interface Finished<C extends Card = Card> extends Takeover<C> {
  endMs: number;
  corners: number;
}

export interface BoardState<C extends Card = Card> {
  current: Takeover<C> | null;
  queue: Pending<C>[];
}

export type BoardEvent<C extends Card = Card> =
  | { type: "takeover"; takeover: Takeover<C> }
  | { type: "finished"; finished: Finished<C> };

export function seedFor(id: string): number {
  return hashSeed(`takeover:${id}`);
}

function cornerCount(t: Takeover, endMs: number): number {
  return cornerHits(initialPhase(t.seed), 0, (endMs - t.startMs) / 1000).length;
}

/**
 * The earliest moment the current holder can be replaced by someone who became eligible at
 * `readyAtMs`: after the minimum hold, and after 60 s of protection from the last corner hit
 * before that moment. A corner inside the protected window extends it again.
 */
export function handoverMs(cur: Takeover, readyAtMs: number): number {
  const phase = initialPhase(cur.seed);
  let end = Math.max(cur.startMs + MIN_HOLD_MS, readyAtMs);
  for (;;) {
    const hits = cornerHits(phase, 0, (end - cur.startMs) / 1000);
    const last = hits[hits.length - 1];
    const protectedUntil = last ? cur.startMs + last.t * 1000 + CORNER_PROTECT_MS : -Infinity;
    if (protectedUntil <= end) return end;
    end = Math.ceil(protectedUntil);
  }
}

function start<C extends Card>(p: Pending<C>, startMs: number): Takeover<C> {
  return { ...p, startMs, seed: seedFor(p.id) };
}

/**
 * Apply every handover due at or before `nowMs`.
 * Returns the new state, the events to broadcast, and when to wake up next (or null).
 */
export function advance<C extends Card>(
  state: BoardState<C>,
  nowMs: number,
): { state: BoardState<C>; events: BoardEvent<C>[]; wakeAtMs: number | null } {
  let current = state.current;
  const queue = [...state.queue].sort(
    (a, b) => a.paidAtMs - b.paidAtMs || a.id.localeCompare(b.id),
  );
  const events: BoardEvent<C>[] = [];

  if (!current && queue.length) {
    const first = queue.shift() as Pending<C>;
    current = start(first, first.paidAtMs);
    events.push({ type: "takeover", takeover: current });
  }

  while (current && queue.length) {
    const at = handoverMs(current, queue[0].paidAtMs);
    if (at > nowMs) break;
    const finished: Finished<C> = { ...current, endMs: at, corners: cornerCount(current, at) };
    events.push({ type: "finished", finished });
    current = start(queue.shift() as Pending<C>, at);
    events.push({ type: "takeover", takeover: current });
  }

  const wakeAtMs = current && queue.length ? handoverMs(current, queue[0].paidAtMs) : null;
  return { state: { current, queue }, events, wakeAtMs };
}

/** Estimated start time for each queued buyer, for the "time until they take over" display. */
export function estimatedStarts(state: BoardState): number[] {
  const out: number[] = [];
  let cur = state.current;
  for (const p of [...state.queue].sort(
    (a, b) => a.paidAtMs - b.paidAtMs || a.id.localeCompare(b.id),
  )) {
    const at = cur ? handoverMs(cur, p.paidAtMs) : p.paidAtMs;
    out.push(at);
    cur = start(p, at);
  }
  return out;
}
