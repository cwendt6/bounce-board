/**
 * Token checks for cards that list a token (ticker + chain + contract address).
 *
 * The main abuse on boards like this is fake contract addresses: a scammer lists $DEGEN with
 * their own CA. Using DexScreener's public API we check, on the same chain:
 *  1. the ticker matches the token actually at that address,
 *  2. the token has a trading pool with real liquidity,
 *  3. no much bigger token with that ticker lives at a different address.
 * Tickers legitimately repeat across chains, so we never compare across chains.
 * If DexScreener can't be reached, the card is allowed but marked "unverified".
 */
import type { BoardCard } from "./card";

export const DEXSCREENER = "https://api.dexscreener.com";

export interface TokenRules {
  /** Minimum total liquidity (USD) across the token's pools. */
  minLiquidityUsd: number;
  /** A same-ticker token at least this liquid counts as "known". */
  knownLiquidityUsd: number;
  /** ...and it must be at least this many times more liquid than the submitted token. */
  knownRatio: number;
}

export const DEFAULT_RULES: TokenRules = {
  minLiquidityUsd: 1_000,
  knownLiquidityUsd: 100_000,
  knownRatio: 10,
};

interface Token {
  address: string;
  symbol: string;
  name: string;
}

export interface Pair {
  chainId: string;
  baseToken: Token;
  quoteToken: Token;
  liquidity?: { usd?: number };
}

export type TokenCheck =
  | { ok: true; status: "verified" | "unverified" }
  | { ok: false; reason: string };

type Fetch = (url: string) => Promise<Response>;

const same = (a: string, b: string, chain: string) =>
  chain === "solana" ? a === b : a.toLowerCase() === b.toLowerCase();

const liq = (p: Pair) => (typeof p.liquidity?.usd === "number" ? p.liquidity.usd : 0);

async function getJson(fetcher: Fetch, url: string): Promise<unknown> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  return res.json();
}

/** Total liquidity and the on-chain symbol for `address`, from its pairs (either side). */
export function summarize(pairs: Pair[], chain: string, address: string) {
  let liquidity = 0;
  let token: Token | null = null;
  for (const p of pairs) {
    if (p.chainId !== chain) continue;
    if (same(p.baseToken.address, address, chain)) token ??= p.baseToken;
    else if (same(p.quoteToken.address, address, chain)) token ??= p.quoteToken;
    else continue;
    liquidity += liq(p);
  }
  return { liquidity, token };
}

/** The most liquid other token on `chain` whose symbol equals `ticker`. */
export function biggestNamesake(pairs: Pair[], chain: string, ticker: string, address: string) {
  const totals = new Map<string, { token: Token; liquidity: number }>();
  for (const p of pairs) {
    if (p.chainId !== chain) continue;
    for (const t of [p.baseToken, p.quoteToken]) {
      if (t.symbol.toUpperCase() !== ticker.toUpperCase() || same(t.address, address, chain))
        continue;
      const key = chain === "solana" ? t.address : t.address.toLowerCase();
      const e = totals.get(key) ?? { token: t, liquidity: 0 };
      e.liquidity += liq(p);
      totals.set(key, e);
    }
  }
  return [...totals.values()].sort((a, b) => b.liquidity - a.liquidity)[0] ?? null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function checkToken(
  card: BoardCard,
  fetcher: Fetch,
  rules: TokenRules = DEFAULT_RULES,
): Promise<TokenCheck> {
  if (!card.ticker || !card.chain || !card.contract) return { ok: true, status: "verified" };
  const { ticker, chain, contract } = card;

  let own: Pair[];
  let search: Pair[];
  try {
    const [a, b] = await Promise.all([
      getJson(fetcher, `${DEXSCREENER}/token-pairs/v1/${chain}/${encodeURIComponent(contract)}`),
      getJson(fetcher, `${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(ticker)}`),
    ]);
    own = Array.isArray(a) ? (a as Pair[]) : [];
    search = Array.isArray((b as { pairs?: unknown })?.pairs)
      ? ((b as { pairs: Pair[] }).pairs ?? [])
      : [];
  } catch (e) {
    console.error("token check unavailable", e);
    return { ok: true, status: "unverified" };
  }

  const { liquidity, token } = summarize(own, chain, contract);
  if (!token) return { ok: false, reason: `no trading pool found for this contract on ${chain}` };
  if (token.symbol.toUpperCase() !== ticker.toUpperCase()) {
    return { ok: false, reason: `the token at this contract is $${token.symbol}, not $${ticker}` };
  }
  if (liquidity < rules.minLiquidityUsd) {
    return {
      ok: false,
      reason: `liquidity is below $${rules.minLiquidityUsd.toLocaleString("en-US")}`,
    };
  }
  const namesake = biggestNamesake(search, chain, ticker, contract);
  if (
    namesake &&
    namesake.liquidity >= rules.knownLiquidityUsd &&
    namesake.liquidity >= liquidity * rules.knownRatio
  ) {
    return {
      ok: false,
      reason: `$${ticker} on ${chain} is a different, larger token (${short(namesake.token.address)}); this contract looks like a copy`,
    };
  }
  return { ok: true, status: "verified" };
}
