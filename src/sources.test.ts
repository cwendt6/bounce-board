import { describe, expect, it } from "vitest";
import { ClockSync, demoSource, type Snapshot, snapshotToView } from "./sources";

describe("ClockSync", () => {
  it("uses the midpoint of the round trip and keeps the fastest sample", () => {
    const c = new ClockSync();
    c.sample(1000, 1100, 5050); // rtt 100, offset 5050 - 1050 = 4000
    expect(c.offset).toBe(4000);
    c.sample(2000, 2300, 6500); // slower sample is ignored
    expect(c.offset).toBe(4000);
    c.sample(3000, 3020, 7011); // rtt 20, offset 7011 - 3010 = 4001
    expect(c.offset).toBe(4001);
  });

  it("seeds from the first snapshot until a ping arrives", () => {
    const c = new ClockSync();
    c.seed(10_000, 9_000);
    expect(c.offset).toBe(1000);
    c.sample(1000, 1010, 2005);
    expect(c.offset).toBe(1000);
  });
});

describe("views", () => {
  it("builds a demo view", () => {
    const v = demoSource.view();
    expect(v.mode).toBe("demo");
    expect(v.current?.endMs).not.toBeNull();
    expect(v.queue).toHaveLength(4);
    expect(v.recent).toHaveLength(10);
  });

  it("maps a live snapshot", () => {
    const card = { name: "A", description: "", link: "https://a.example", color: "#fff" };
    const s: Snapshot = {
      serverNow: 5,
      current: { id: "x", card, startMs: 1, seed: 2 },
      queue: [{ id: "y", card, estStartMs: 61_001 }],
      recent: [{ id: "z", card, startMs: 0, endMs: 90_000, corners: 1 }],
      cornerClub: [],
      longest: [],
      stats: { takeovers: 2, uniqueHolders: 1 },
    };
    const v = snapshotToView(s, 10);
    expect(v.current?.endMs).toBeNull();
    expect(v.queue[0].startMs).toBe(61_001);
    expect(v.recent[0]).toEqual({ card, heldMs: 90_000, corners: 1 });
  });
});
