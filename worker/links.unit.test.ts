import { describe, expect, it } from "vitest";
import {
  checkDescription,
  checkLink,
  domainChain,
  levenshtein,
  type PhishingLookup,
} from "./links";

const list: PhishingLookup = {
  isBlacklisted: (d) => d.some((x) => ["opencea.mom", "drainer.example"].includes(x)),
  isWhitelisted: (d) => d.includes("metamask.io"),
  fuzzylist: () => ({ entries: ["metamask.io", "opensea.io"], tolerance: 1 }),
};

describe("link checks", () => {
  it("walks parent domains", () => {
    expect(domainChain("a.b.example.com")).toEqual([
      "a.b.example.com",
      "b.example.com",
      "example.com",
    ]);
  });

  it("measures edit distance with an early exit", () => {
    expect(levenshtein("opensea.io", "opensae.io")).toBe(2);
    expect(levenshtein("opensea.io", "opensea.co")).toBe(1);
    expect(levenshtein("abc", "abcdef", 1)).toBe(2);
  });

  it("allows ordinary links", () => {
    expect(checkLink("https://example.com/coffee", list)).toEqual({ ok: true });
    expect(checkLink("https://x.com/DegenCapitalVC", list)).toEqual({ ok: true });
  });

  it("blocks blacklisted domains and their subdomains", () => {
    expect(checkLink("https://opencea.mom/claim", list).ok).toBe(false);
    expect(checkLink("https://airdrop.drainer.example/", list).ok).toBe(false);
  });

  it("blocks one-edit imitations of protected brands, but not the brands", () => {
    const r = checkLink("https://metamsk.io/", list);
    expect(!r.ok && r.reason).toMatch(/imitation of metamask.io/);
    expect(checkLink("https://opensea.co/", list).ok).toBe(false);
    expect(checkLink("https://metamask.io/download", list)).toEqual({ ok: true });
  });

  it("blocks IP hosts and punycode look-alikes even without the list", () => {
    expect(checkLink("https://192.168.1.10/", null).ok).toBe(false);
    expect(checkLink("https://xn--metamsk-0ya.io/", null).ok).toBe(false);
    expect(checkLink("https://example.com/", null)).toEqual({ ok: true });
  });

  it("keeps links and domains out of descriptions", () => {
    expect(checkDescription("STAY BASED")).toEqual({ ok: true });
    expect(checkDescription("v2.0 is live, 100% on-chain")).toEqual({ ok: true });
    expect(checkDescription("Claim at https://example.com").ok).toBe(false);
    expect(checkDescription("connect at www.example.com").ok).toBe(false);
    expect(checkDescription("visit claim-airdrop.xyz now").ok).toBe(false);
  });
});
