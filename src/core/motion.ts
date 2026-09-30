/**
 * Box motion on the projector screen.
 *
 * Position is a pure function of (seconds since takeover start, seed), so every client and
 * the server compute the same box position and the same corner hits with no position sync.
 * The screen is a fixed 4:3 surface; clients scale and letterbox it.
 *
 * Each axis moves at constant speed and reflects off the walls, which is a triangle wave.
 * We track a "phase" u in [0, 2L): the box is at u when u <= L and at 2L - u when moving back.
 */
import { mulberry32 } from "./rng";

export const SCREEN_W = 4;
export const SCREEN_H = 3;
export const BOX_W = 0.9;
export const BOX_H = 0.5;
/** Speed per axis, in screen units per second. */
export const SPEED = 0.32;
/** A wall hit counts as a corner if the other axis is within this distance of its wall. */
export const CORNER_EPS = 0.02;

export const RANGE_X = SCREEN_W - BOX_W;
export const RANGE_Y = SCREEN_H - BOX_H;

export interface Phase {
  ux: number;
  uy: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface CornerHit {
  /** Seconds since takeover start. */
  t: number;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function tri(u: number, range: number): number {
  const p = mod(u, 2 * range);
  return p <= range ? p : 2 * range - p;
}

/** Starting phase for a takeover. Uses the seed so each takeover starts somewhere new. */
export function initialPhase(seed: number): Phase {
  const rand = mulberry32(seed);
  return { ux: rand() * 2 * RANGE_X, uy: rand() * 2 * RANGE_Y };
}

/** Top-left corner of the box, in screen units, `t` seconds after the takeover started. */
export function positionAt(phase: Phase, t: number): Point {
  return {
    x: tri(phase.ux + SPEED * t, RANGE_X),
    y: tri(phase.uy + SPEED * t, RANGE_Y),
  };
}

function distToWall(u: number, range: number): number {
  const p = mod(u, range);
  return Math.min(p, range - p);
}

/**
 * Corner hits in [from, to) seconds since takeover start, in time order.
 * We walk every x-wall hit (phase is a multiple of RANGE_X) and check how close y is to a
 * wall at that moment. Integer arithmetic on the hit index keeps this exact and cheap.
 */
export function cornerHits(phase: Phase, from: number, to: number): CornerHit[] {
  const hits: CornerHit[] = [];
  let k = Math.ceil((phase.ux + SPEED * from) / RANGE_X);
  for (;;) {
    const t = (k * RANGE_X - phase.ux) / SPEED;
    if (t >= to) break;
    if (t >= from) {
      const uy = phase.uy + SPEED * t;
      if (distToWall(uy, RANGE_Y) <= CORNER_EPS) {
        const right = mod(k, 2) === 1;
        const bottom = tri(uy, RANGE_Y) > RANGE_Y / 2;
        const corner = `${bottom ? "bottom" : "top"}-${right ? "right" : "left"}` as const;
        hits.push({ t, corner });
      }
    }
    k++;
  }
  return hits;
}
