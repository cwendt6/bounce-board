/**
 * Buyer card validation. Milestone 2 checks shape and formats only; moderation and
 * token/link reputation checks arrive in milestone 3.
 */
import type { Card } from "../src/core/queue";

export type Chain = "base" | "solana" | "ethereum";

export interface BoardCard extends Card {
  description: string;
  link: string;
  x?: string;
  ticker?: string;
  chain?: Chain;
  contract?: string;
  /** Set by the server only ("/api/logo/<takeover id>"), never taken from buyer input. */
  logo?: string;
  /** Set by the server only: result of the DexScreener token checks. */
  tokenCheck?: "verified" | "unverified";
}

const CHAINS: Chain[] = ["base", "solana", "ethereum"];
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

type Result = { ok: true; card: BoardCard } | { ok: false; errors: string[] };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function validateCard(input: unknown): Result {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const name = str(o.name);
  const description = str(o.description);
  const link = str(o.link);
  const x = str(o.x).replace(/^@/, "");
  const ticker = str(o.ticker).replace(/^\$/, "").toUpperCase();
  const chain = str(o.chain).toLowerCase();
  const contract = str(o.contract);

  if (!name || name.length > 32) errors.push("name: 1 to 32 characters");
  if (description.length > 120) errors.push("description: at most 120 characters");
  for (const [k, v] of Object.entries({ name, description, x, ticker, contract })) {
    if (CONTROL.test(v)) errors.push(`${k}: control characters are not allowed`);
  }

  let url: URL | null = null;
  try {
    url = new URL(link);
  } catch {
    url = null;
  }
  if (url?.protocol !== "https:" || !url.hostname.includes(".") || link.length > 200) {
    errors.push("link: a valid https URL, at most 200 characters");
  }

  if (x && !/^[A-Za-z0-9_]{1,15}$/.test(x)) errors.push("x: a valid X handle");

  const anyToken = ticker || chain || contract;
  if (anyToken) {
    if (!/^[A-Z0-9]{1,12}$/.test(ticker)) errors.push("ticker: 1 to 12 letters or digits");
    if (!CHAINS.includes(chain as Chain)) errors.push(`chain: one of ${CHAINS.join(", ")}`);
    const evm = chain === "base" || chain === "ethereum";
    if (evm && !EVM_ADDRESS.test(contract))
      errors.push("contract: a 0x address (40 hex characters)");
    if (chain === "solana" && !SOLANA_ADDRESS.test(contract)) {
      errors.push("contract: a base58 Solana address");
    }
  }

  if (errors.length) return { ok: false, errors };
  const card: BoardCard = {
    name,
    description,
    link: (url as URL).toString(),
  };
  if (x) card.x = x;
  if (anyToken) {
    card.ticker = ticker;
    card.chain = chain as Chain;
    card.contract = contract;
  }
  return { ok: true, card };
}
