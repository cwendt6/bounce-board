import { describe, expect, it } from "vitest";
import {
  CORNER_EPS,
  cornerHits,
  initialPhase,
  positionAt,
  RANGE_X,
  RANGE_Y,
  SPEED,
} from "./motion";

describe("positionAt", () => {
  it("stays on screen", () => {
    const phase = initialPhase(12345);
    for (let t = 0; t < 600; t += 0.37) {
      const p = positionAt(phase, t);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(RANGE_X);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(RANGE_Y);
    }
  });

  it("moves continuously at constant speed per axis", () => {
    const phase = initialPhase(7);
    const dt = 0.01;
    for (let t = 0; t < 120; t += 0.5) {
      const a = positionAt(phase, t);
      const b = positionAt(phase, t + dt);
      expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(SPEED * dt + 1e-9);
      expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual(SPEED * dt + 1e-9);
    }
  });

  it("is deterministic for a seed", () => {
    expect(positionAt(initialPhase(99), 42.5)).toEqual(positionAt(initialPhase(99), 42.5));
    expect(initialPhase(1)).not.toEqual(initialPhase(2));
  });
});

describe("cornerHits", () => {
  it("finds the corners of a box that starts in the top-left corner", () => {
    // RANGE_X = 3.1 and RANGE_Y = 2.5, so 25 x-crossings line up with 31 y-crossings.
    const hits = cornerHits({ ux: 0, uy: 0 }, 0, (25 * RANGE_X) / SPEED + 1);
    expect(hits[0]).toEqual({ t: 0, corner: "top-left" });
    const last = hits[hits.length - 1];
    expect(last.t).toBeCloseTo((25 * RANGE_X) / SPEED, 9);
    expect(last.corner).toBe("bottom-right");
  });

  it("uses a half-open window so consecutive windows never double count", () => {
    const phase = { ux: 0, uy: 0 };
    const end = (25 * RANGE_X) / SPEED + 1;
    const whole = cornerHits(phase, 0, end);
    const split = [...cornerHits(phase, 0, 100), ...cornerHits(phase, 100, end)];
    expect(split).toEqual(whole);
  });

  it("agrees with brute-force sampling of the path", () => {
    for (const seed of [1, 2, 3, 42, 2026]) {
      const phase = initialPhase(seed);
      const hits = cornerHits(phase, 0, 3600);
      for (const h of hits) {
        const p = positionAt(phase, h.t);
        const nearX = Math.min(p.x, RANGE_X - p.x);
        const nearY = Math.min(p.y, RANGE_Y - p.y);
        expect(nearX).toBeLessThan(1e-9);
        expect(nearY).toBeLessThanOrEqual(CORNER_EPS + 1e-9);
        const [v, h2] = h.corner.split("-");
        expect(p.y > RANGE_Y / 2).toBe(v === "bottom");
        expect(p.x > RANGE_X / 2).toBe(h2 === "right");
      }
    }
  });

  it("reports nothing when the path stays away from corners", () => {
    // Start mid-screen; the first x-wall hit is far from any y wall.
    const hits = cornerHits({ ux: RANGE_X / 2, uy: RANGE_Y / 2 }, 0, 5);
    expect(hits).toEqual([]);
  });
});
