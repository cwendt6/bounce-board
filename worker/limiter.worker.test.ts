import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const limiter = (name: string) => env.LIMITER.get(env.LIMITER.idFromName(name));
const rule = { limit: 3, windowMs: 60_000 };

describe("RateLimiter", () => {
  it("allows up to the limit in a window, then refuses with a retry time", async () => {
    const l = limiter("basic");
    const t = Date.UTC(2026, 9, 1, 12, 0, 10);
    for (let i = 0; i < 3; i++) expect((await l.hit("ip:a", rule, t)).ok).toBe(true);
    const r = await l.hit("ip:a", rule, t);
    expect(r).toEqual({ ok: false, retryAfter: 50 });
  });

  it("keeps keys separate and resets in the next window", async () => {
    const l = limiter("windows");
    const t = Date.UTC(2026, 9, 1, 12, 0, 0);
    for (let i = 0; i < 3; i++) await l.hit("ip:b", rule, t);
    expect((await l.hit("ip:b", rule, t)).ok).toBe(false);
    expect((await l.hit("ip:c", rule, t)).ok).toBe(true);
    expect((await l.hit("ip:b", rule, t + 60_000)).ok).toBe(true);
  });
});

describe("route limits", () => {
  it("answers 429 with Retry-After once an IP has sent too many reports", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 15; i++) {
      last = await SELF.fetch("https://board.test/api/report", {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000000", category: "scam" }),
      });
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
