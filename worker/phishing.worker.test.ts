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
    expect(
      await s.load({
        blacklist,
        whitelist: ["metamask.io"],
        fuzzylist: ["metamask.io", "opensea.io"],
        tolerance: 1,
      }),
    ).toBe(1202);
    expect(await s.check("https://example.com/coffee")).toEqual({ ok: true });
    expect((await s.check("https://opencea.mom/claim")).ok).toBe(false);
    expect((await s.check("https://airdrop.drainer.example/")).ok).toBe(false);
    expect((await s.check("https://metamsk.io/")).ok).toBe(false);
    expect(await s.check("https://metamask.io/")).toEqual({ ok: true });
    const st = await s.status();
    expect(st.domains).toBe(1202);
    expect(st.refreshedAt).toBeTypeOf("number");
  });

  it("replaces the list on reload", async () => {
    const s = store("reload");
    await s.load({ blacklist, whitelist: [], fuzzylist: [], tolerance: 1 });
    await s.load({ blacklist: blacklist.slice(1), whitelist: [], fuzzylist: [], tolerance: 1 });
    expect(await s.check("https://opencea.mom/")).toEqual({ ok: true });
    expect((await s.status()).domains).toBe(1201);
  });
});
