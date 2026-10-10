import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ipBucket } from "./limiter";

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

describe("peek and hitAll", () => {
  it("peek counts nothing", async () => {
    const l = limiter("peek");
    const t = Date.UTC(2026, 9, 1, 12, 0, 0);
    for (let i = 0; i < 5; i++) expect((await l.peek("k", rule, t)).ok).toBe(true);
    for (let i = 0; i < 3; i++) await l.hit("k", rule, t);
    expect((await l.peek("k", rule, t)).ok).toBe(false);
  });

  it("hitAll counts every key or none", async () => {
    const l = limiter("hitall");
    const t = Date.UTC(2026, 9, 1, 12, 0, 0);
    for (let i = 0; i < 3; i++) await l.hit("full", rule, t);
    const r = await l.hitAll(
      [
        { key: "free", rule },
        { key: "full", rule },
      ],
      t,
    );
    expect(r.ok).toBe(false);
    // "free" was not counted, so it still has all 3 slots.
    for (let i = 0; i < 3; i++) expect((await l.hit("free", rule, t)).ok).toBe(true);
    expect((await l.hit("free", rule, t)).ok).toBe(false);
  });

  it("unhitAll gives back one hit per key, never below zero", async () => {
    const l = limiter("unhit");
    const t = Date.UTC(2026, 9, 1, 12, 0, 0);
    const keys = [
      { key: "u1", rule },
      { key: "u2", rule },
    ];
    for (let i = 0; i < 3; i++) await l.hitAll(keys, t);
    expect((await l.peek("u1", rule, t)).ok).toBe(false);
    await l.unhitAll(keys, t);
    expect((await l.hitAll(keys, t)).ok).toBe(true);
    // An empty window stays at zero.
    await l.unhitAll([{ key: "never", rule }], t);
    for (let i = 0; i < 3; i++) expect((await l.hit("never", rule, t)).ok).toBe(true);
    expect((await l.hit("never", rule, t)).ok).toBe(false);
  });
});

describe("ipBucket", () => {
  it("keeps IPv4 addresses whole", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
  });

  it("groups IPv6 addresses by /64, including compressed forms", () => {
    const a = ipBucket("2001:db8:abcd:12::1");
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(ipBucket("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff")).toBe(a);
    expect(ipBucket("2001:db8:abcd:13::1")).not.toBe(a);
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("2001:db8:abcd:12::1", 48)).toBe("2001:db8:abcd::/48");
    expect(ipBucket("2001:db8:abcd:ff00::9", 48)).toBe("2001:db8:abcd::/48");
    expect(ipBucket("203.0.113.7", 48)).toBe("203.0.113.7");
    expect(ipBucket("2001:db8::")).toBe("2001:db8:0:0::/64");
  });
});
