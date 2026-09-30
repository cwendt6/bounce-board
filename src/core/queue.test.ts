import { describe, expect, it } from "vitest";
import { cornerHits, initialPhase } from "./motion";
import {
  advance,
  type BoardState,
  CORNER_PROTECT_MS,
  estimatedStarts,
  handoverMs,
  MIN_HOLD_MS,
  type Pending,
  seedFor,
  type Takeover,
} from "./queue";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function pending(id: string, paidAtMs: number): Pending {
  return { id, paidAtMs, card: { name: id } };
}

/** First takeover id whose path satisfies `pred` on its corner hits in the first `secs`. */
function findId(pred: (hits: number[]) => boolean, secs: number): string {
  for (let i = 0; i < 100_000; i++) {
    const id = `sale-${i}`;
    const hits = cornerHits(initialPhase(seedFor(id)), 0, secs).map((h) => h.t);
    if (pred(hits)) return id;
  }
  throw new Error("no id found");
}

const QUIET = findId((h) => h.length === 0, 600); // no corners in 10 minutes
const EARLY_CORNER = findId((h) => h.length === 1 && h[0] > 30 && h[0] < 60, 180);

describe("advance", () => {
  it("lets the first buyer take an empty board right away", () => {
    const r = advance({ current: null, queue: [pending(QUIET, T0)] }, T0);
    expect(r.state.current?.startMs).toBe(T0);
    expect(r.state.current?.seed).toBe(seedFor(QUIET));
    expect(r.events.map((e) => e.type)).toEqual(["takeover"]);
    expect(r.wakeAtMs).toBeNull();
  });

  it("holds the box for the minimum hold before the next buyer", () => {
    const s: BoardState = { current: null, queue: [pending(QUIET, T0), pending("b", T0 + 5_000)] };
    const early = advance(s, T0 + 30_000);
    expect(early.state.current?.id).toBe(QUIET);
    expect(early.wakeAtMs).toBe(T0 + MIN_HOLD_MS);

    const later = advance(early.state, T0 + MIN_HOLD_MS);
    expect(later.state.current?.id).toBe("b");
    expect(later.state.current?.startMs).toBe(T0 + MIN_HOLD_MS);
    const fin = later.events.find((e) => e.type === "finished");
    expect(fin?.type === "finished" && fin.finished.endMs).toBe(T0 + MIN_HOLD_MS);
  });

  it("hands over as soon as a late buyer pays, when the minimum hold has passed", () => {
    const s = advance({ current: null, queue: [pending(QUIET, T0)] }, T0).state;
    const paid = T0 + 5 * 60_000;
    const r = advance({ ...s, queue: [pending("late", paid)] }, paid);
    expect(r.state.current?.id).toBe("late");
    expect(r.state.current?.startMs).toBe(paid);
  });

  it("protects a holder for 60 s after a corner hit", () => {
    const cur: Takeover = {
      ...pending(EARLY_CORNER, T0),
      startMs: T0,
      seed: seedFor(EARLY_CORNER),
    };
    const hitT = cornerHits(initialPhase(cur.seed), 0, 60)[0].t;
    const expected = Math.ceil(T0 + hitT * 1000 + CORNER_PROTECT_MS);
    expect(expected).toBeGreaterThan(T0 + MIN_HOLD_MS);
    expect(handoverMs(cur, T0 + 1_000)).toBe(expected);
  });

  it("serves buyers in the order they paid", () => {
    const s: BoardState = {
      current: null,
      queue: [pending("c", T0 + 3), pending(QUIET, T0), pending("b", T0 + 2)],
    };
    const r = advance(s, T0);
    expect(r.state.current?.id).toBe(QUIET);
    expect(r.state.queue.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("records corner hits for finished reigns", () => {
    const s = advance({ current: null, queue: [pending(EARLY_CORNER, T0)] }, T0).state;
    const r = advance({ ...s, queue: [pending("next", T0 + 1)] }, T0 + 10 * 60_000);
    const fin = r.events.find((e) => e.type === "finished");
    expect(fin?.type === "finished" && fin.finished.corners).toBe(1);
  });

  it("estimates start times that match what advance does", () => {
    const s: BoardState = {
      current: null,
      queue: [pending(QUIET, T0), pending("b", T0 + 1), pending("c", T0 + 2)],
    };
    const first = advance(s, T0).state;
    const est = estimatedStarts(first);
    const r = advance(first, T0 + 60 * 60_000);
    const starts = r.events.flatMap((e) => (e.type === "takeover" ? [e.takeover.startMs] : []));
    expect(starts).toEqual(est);
  });
});
