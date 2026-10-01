import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const store = (name: string) => env.PHISHING.get(env.PHISHING.idFromName(name));
const blacklist = [
  "opencea.mom",
  "drainer.example",
  ...Array.from({ length: 1200 }, (_, i) => `bad${i}.example`),
];

describe("PhishingListStore", () => {
  it("answers link checks from the stored list", async () => {
    const s = store("checks");
    const first = await s.load({
      blacklist,
      whitelist: ["metamask.io"],
      fuzzylist: ["metamask.io", "opensea.io"],
      tolerance: 1,
    });
    expect(first.domains).toBe(1202);
    // A handful of rows, not one per domain (free plan: 100k rows written per day).
    expect(first.rowsWritten).toBeLessThanOrEqual(3);
    expect(await s.check("https://example.com/coffee")).toEqual({ ok: true });
    expect((await s.check("https://opencea.mom/claim")).ok).toBe(false);
    expect((await s.check("https://airdrop.drainer.example/")).ok).toBe(false);
    expect((await s.check("https://metamsk.io/")).ok).toBe(false);
    expect(await s.check("https://metamask.io/")).toEqual({ ok: true });
    const st = await s.status();
    expect(st.domains).toBe(1202);
    expect(st.refreshedAt).toBeTypeOf("number");
  });

  it("writes almost nothing when the list hasn't changed", async () => {
    const s = store("unchanged");
    const list = { blacklist, whitelist: [], fuzzylist: [], tolerance: 1 };
    await s.load(list);
    const again = await s.load(list);
    expect(again.rowsWritten).toBe(0);
  });

  it("stays tiny for a full-size list", async () => {
    const s = store("full-size");
    const big = Array.from({ length: 101_548 }, (_, i) => `phish-${i}-example-domain.xyz`);
    const r = await s.load({ blacklist: big, whitelist: [], fuzzylist: [], tolerance: 1 });
    expect(r.domains).toBe(101_548);
    expect(r.rowsWritten).toBeLessThanOrEqual(6);
    expect((await s.check("https://phish-77777-example-domain.xyz/")).ok).toBe(false);
  });

  it("replaces the list on reload", async () => {
    const s = store("reload");
    await s.load({ blacklist, whitelist: [], fuzzylist: [], tolerance: 1 });
    await s.load({ blacklist: blacklist.slice(1), whitelist: [], fuzzylist: [], tolerance: 1 });
    expect(await s.check("https://opencea.mom/")).toEqual({ ok: true });
    expect((await s.status()).domains).toBe(1201);
  });
});
