import { describe, expect, it } from "vitest";
import { liveCorners, mergeCornerClub, mergeLongest } from "./leaderboard";
import { cornerHits, initialPhase } from "./motion";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

/** A seed whose path hits at least one corner in its first `secs` seconds. */
function seedWithCorner(secs: number): number {
  for (let s = 1; s < 100_000; s++) if (cornerHits(initialPhase(s), 0, secs).length) return s;
  throw new Error("none");
}

describe("leaderboards with the live reign", () => {
  it("counts the current holder's corners on top of earlier ones", () => {
    const seed = seedWithCorner(600);
    const live = { key: "$lampo", label: "$LAMPO", startMs: T0, seed, priorCorners: 2 };
    const now = T0 + 600_000;
    const n = liveCorners(live, now);
    expect(n).toBeGreaterThan(0);
    const club = mergeCornerClub([{ key: "$lampo", label: "$LAMPO", corners: 2 }], live, now);
    expect(club).toEqual([{ key: "$lampo", label: "$LAMPO", corners: 2 + n }]);
  });

  it("leaves the club alone before the live holder hits a corner", () => {
    const finished = [{ key: "a", label: "A", corners: 3 }];
    const live = { key: "b", label: "B", startMs: T0, seed: 1, priorCorners: 0 };
    expect(mergeCornerClub(finished, live, T0)).toEqual(finished);
  });

  it("ranks the reign in progress among the longest", () => {
    const finished = [
      { label: "A", ms: 90_000 },
      { label: "B", ms: 30_000 },
    ];
    const live = { key: "c", label: "C", startMs: T0, seed: 1, priorCorners: 0 };
    expect(mergeLongest(finished, live, T0 + 60_000).map((r) => r.label)).toEqual(["A", "C", "B"]);
  });

  it("keeps the top five", () => {
    const finished = Array.from({ length: 8 }, (_, i) => ({
      key: `k${i}`,
      label: `L${i}`,
      corners: i + 1,
    }));
    expect(mergeCornerClub(finished, null, T0)).toHaveLength(5);
    expect(mergeCornerClub(finished, null, T0)[0].corners).toBe(8);
  });
});
