import { describe, expect, it } from "vitest";
import type { BoardCard } from "./card";
import searchDegen from "./fixtures/dexscreener-search-degen.json";
import usdcPairs from "./fixtures/dexscreener-token-pairs-usdc-base.json";
import { biggestNamesake, checkToken, type Pair, summarize } from "./tokens";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEGEN_BASE = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const FAKE = "0x00000000000000000000000000000000000fa4e0";

const base: BoardCard = { name: "Test", description: "", link: "https://example.com/" };
const token = (ticker: string, contract: string, chain: "base" | "solana" = "base"): BoardCard => ({
  ...base,
  ticker,
  chain,
  contract,
});

const searchPairs = searchDegen.pairs as Pair[];
const realDegenPairs = searchPairs.filter((p) => p.chainId === "base");

/** Answers token-pairs from `own` and search from the DEGEN search fixture. */
function fake(own: unknown, opts: { status?: number } = {}) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    if (opts.status) return new Response("rate limited", { status: opts.status });
    const body = url.includes("/token-pairs/") ? own : searchDegen;
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
  return { fetcher, calls };
}

function fakePool(symbol: string, address: string, usd: number, chain = "base"): Pair[] {
  return [
    {
      chainId: chain,
      baseToken: { address, symbol, name: symbol },
      quoteToken: {
        address: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        name: "Wrapped Ether",
      },
      liquidity: { usd },
    },
  ];
}

describe("DexScreener fixtures (pinned response shapes)", () => {
  it("token-pairs returns pairs with base/quote tokens and liquidity", () => {
    const s = summarize(usdcPairs as Pair[], "base", USDC_BASE);
    expect(s.token?.symbol).toBe("USDC");
    expect(s.liquidity).toBeGreaterThan(1_000);
  });

  it("search only compares tokens on the same chain", () => {
    // DEGEN on another chain is far more liquid, but only Base's DEGEN counts for Base.
    const n = biggestNamesake(searchPairs, "base", "DEGEN", FAKE);
    expect(n?.token.address).toBe(DEGEN_BASE);
    expect(n?.liquidity).toBeGreaterThan(100_000);
  });
});

describe("checkToken", () => {
  it("skips cards without a token, with no network calls", async () => {
    const f = fake([]);
    expect(await checkToken(base, f.fetcher)).toEqual({ ok: true, status: "verified" });
    expect(f.calls).toEqual([]);
  });

  it("verifies a real token at its real address", async () => {
    const r = await checkToken(token("USDC", USDC_BASE), fake(usdcPairs).fetcher);
    expect(r).toEqual({ ok: true, status: "verified" });
  });

  it("verifies the real DEGEN even though a bigger DEGEN exists on another chain", async () => {
    const r = await checkToken(token("degen", DEGEN_BASE), fake(realDegenPairs).fetcher);
    expect(r).toEqual({ ok: true, status: "verified" });
  });

  it("rejects a fake CA for a known ticker", async () => {
    const r = await checkToken(token("DEGEN", FAKE), fake(fakePool("DEGEN", FAKE, 5_000)).fetcher);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/different, larger token \(0x4ed4/);
  });

  it("rejects a ticker that doesn't match the token at the address", async () => {
    const r = await checkToken(token("DEGEN", USDC_BASE), fake(usdcPairs).fetcher);
    expect(!r.ok && r.reason).toBe("the token at this contract is $USDC, not $DEGEN");
  });

  it("rejects a token with no pool or near-zero liquidity", async () => {
    expect((await checkToken(token("NEWCOIN", FAKE), fake([]).fetcher)).ok).toBe(false);
    const thin = await checkToken(
      token("NEWCOIN", FAKE),
      fake(fakePool("NEWCOIN", FAKE, 50)).fetcher,
    );
    expect(!thin.ok && thin.reason).toMatch(/liquidity is below \$1,000/);
  });

  it("allows but marks unverified when DexScreener is unavailable", async () => {
    const r = await checkToken(token("DEGEN", FAKE), fake([], { status: 429 }).fetcher);
    expect(r).toEqual({ ok: true, status: "unverified" });
  });
});
