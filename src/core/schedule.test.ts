import { describe, expect, it } from "vitest";
import { DEMO_REIGN_SECONDS, reignAt, upcoming } from "./schedule";

describe("demo schedule", () => {
  it("gives every browser the same reign for the same moment", () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 30);
    expect(reignAt(now, 5)).toEqual(reignAt(now + 10, 5));
  });

  it("rotates holders on a fixed cycle", () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 0);
    const a = reignAt(now, 5);
    const b = reignAt(a.endMs, 5);
    expect(b.startMs).toBe(a.endMs);
    expect(b.holder).toBe((a.holder + 1) % 5);
    expect(b.seed).not.toBe(a.seed);
    expect(a.endMs - a.startMs).toBe(DEMO_REIGN_SECONDS * 1000);
  });

  it("lists the queue in order", () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 0);
    const q = upcoming(now, 5, 3);
    expect(q).toHaveLength(3);
    expect(q[0].startMs).toBe(reignAt(now, 5).endMs);
    expect(q[2].startMs - q[1].startMs).toBe(DEMO_REIGN_SECONDS * 1000);
  });
});
