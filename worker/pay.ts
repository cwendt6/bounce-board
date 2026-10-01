/**
 * x402 payments for POST /api/take.
 *
 * Order matters: validate the card, then verify the payment, then settle it, and only then
 * record the sale and queue the takeover. The x402 Hono middleware settles after the route
 * handler runs, which could queue a takeover for a payment that later fails, so we call the
 * resource server directly instead.
 */
import { HTTPFacilitatorClient } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { type BoardCard, validateCard } from "./card";
import { type Logo, parseLogo } from "./logo";
import type { Verdict } from "./moderation";
import type { TokenCheck } from "./tokens";

export const BASE_MAINNET = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";
const USDC_DECIMALS = 6;

export interface PayConfig {
  network: string;
  payTo: string;
  priceUsd: string;
  facilitatorUrl: string;
}

/** One settled sale, in the same columns as the sales table and CSV export. */
export interface Sale {
  id: string;
  takeover_id: string;
  network: "mainnet" | "testnet";
  chain: "base";
  asset: "USDC";
  amount: string;
  usd_value: string;
  tx_hash: string;
  payer: string;
  receiver: string;
  received_at: number;
  facilitator: string;
}

/** What the route needs from x402. The real one talks to a facilitator; tests use a fake. */
export interface Gateway {
  requirements(resourceUrl: string): Promise<PaymentRequired>;
  verify(
    payload: PaymentPayload,
    req: PaymentRequirements,
  ): Promise<{ ok: boolean; reason?: string }>;
  settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse>;
}

export class X402Gateway implements Gateway {
  private server: x402ResourceServer;
  private ready: Promise<void> | null = null;

  constructor(private readonly cfg: PayConfig) {
    this.server = new x402ResourceServer(
      new HTTPFacilitatorClient({ url: cfg.facilitatorUrl }),
    ).register(cfg.network as `${string}:${string}`, new ExactEvmScheme());
  }

  private init(): Promise<void> {
    this.ready ??= this.server.initialize().catch((e) => {
      this.ready = null; // retry on the next request
      throw e;
    });
    return this.ready;
  }

  async requirements(resourceUrl: string): Promise<PaymentRequired> {
    await this.init();
    const accepts = await this.server.buildPaymentRequirements({
      scheme: "exact",
      network: this.cfg.network as `${string}:${string}`,
      payTo: this.cfg.payTo,
      price: `$${this.cfg.priceUsd}`,
      maxTimeoutSeconds: 120,
    });
    return this.server.createPaymentRequiredResponse(accepts, {
      url: resourceUrl,
      description: "Take the Bounce Board box",
      mimeType: "application/json",
      serviceName: "Bounce Board",
    });
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements) {
    await this.init();
    const r = await this.server.verifyPayment(payload, req);
    return { ok: r.isValid, reason: r.invalidReason ?? r.invalidMessage };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements) {
    await this.init();
    return this.server.settlePayment(payload, req);
  }
}

/** Atomic USDC units (6 decimals) as a decimal string, without floats: "1000000" -> "1.000000". */
export function usdcFromAtomic(atomic: string): string {
  if (!/^\d+$/.test(atomic)) throw new Error(`bad amount: ${atomic}`);
  const padded = atomic.padStart(USDC_DECIMALS + 1, "0");
  return `${padded.slice(0, -USDC_DECIMALS)}.${padded.slice(-USDC_DECIMALS)}`;
}

/** USD value at receipt. USDC is recorded at $1.00 per token, rounded to cents. */
export function usdValue(usdc: string): string {
  const [whole, frac = ""] = usdc.split(".");
  const micro = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6));
  const cents = (micro + 5_000n) / 10_000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

export function facilitatorLabel(url: string): string {
  const host = new URL(url).hostname;
  return host.endsWith("x402.org") ? "x402.org" : host.endsWith("coinbase.com") ? "cdp" : host;
}

export type TakeResult =
  | { status: 400; body: { errors: string[] } }
  | { status: 503; body: { error: string } }
  | { status: 402; body: PaymentRequired }
  | { status: 201; card: BoardCard; logo: Logo | null; sale: Sale; settle: SettleResponse };

export interface TakeDeps {
  gateway: Gateway;
  cfg: PayConfig;
  now: () => number;
  newId: () => string;
  decodePayment: (header: string) => PaymentPayload;
  /** Moderation for the card and its logo data URL (null if none). */
  moderate: (card: BoardCard, logoDataUrl: string | null) => Promise<Verdict>;
  /** DexScreener checks for token cards. */
  checkToken: (card: BoardCard) => Promise<TokenCheck>;
}

/**
 * Everything about POST /api/take except storage: card check, 402, verify, settle, and the
 * sale row. The caller queues the takeover and writes the sale in one transaction.
 */
export async function processTake(
  deps: TakeDeps,
  body: unknown,
  paymentHeader: string | null,
  resourceUrl: string,
): Promise<TakeResult> {
  const card = validateCard(body);
  const logo = parseLogo((body as { logo?: unknown } | null)?.logo);
  const errors = [...(card.ok ? [] : card.errors), ...(logo.ok ? [] : [logo.error])];
  if (!card.ok || !logo.ok) return { status: 400, body: { errors } };

  // Token checks first: they're cheap and catch fake contract addresses.
  const tok = await deps.checkToken(card.card);
  if (!tok.ok) return { status: 400, body: { errors: [`token check: ${tok.reason}`] } };

  // Moderate before quoting a price, so nobody pays for a card we would reject.
  const rawLogo = logo.logo ? String((body as { logo?: unknown }).logo) : null;
  const verdict = await deps.moderate(card.card, rawLogo);
  if (verdict.ok === "unavailable") {
    return {
      status: 503,
      body: {
        error: "Moderation is unavailable right now. Try again later. You have not been charged.",
      },
    };
  }
  if (!verdict.ok) return { status: 400, body: { errors: [`rejected: ${verdict.reason}`] } };

  const required = await deps.gateway.requirements(resourceUrl);
  if (!paymentHeader) return { status: 402, body: required };

  let payload: PaymentPayload;
  try {
    payload = deps.decodePayment(paymentHeader);
  } catch {
    return { status: 402, body: { ...required, error: "unreadable payment header" } };
  }

  const req = required.accepts.find(
    (a) =>
      a.scheme === payload.accepted?.scheme &&
      a.network === payload.accepted?.network &&
      a.asset === payload.accepted?.asset &&
      a.amount === payload.accepted?.amount &&
      a.payTo.toLowerCase() === payload.accepted?.payTo?.toLowerCase(),
  );
  if (!req)
    return { status: 402, body: { ...required, error: "payment does not match the price" } };

  // Paying yourself moves no money and would log a fake sale.
  const from = (payload.payload as { authorization?: { from?: string } })?.authorization?.from;
  if (from && from.toLowerCase() === req.payTo.toLowerCase()) {
    return {
      status: 402,
      body: {
        ...required,
        error: "the payer is the receiving wallet; pay from a different wallet",
      },
    };
  }

  const v = await deps.gateway.verify(payload, req);
  if (!v.ok)
    return {
      status: 402,
      body: { ...required, error: `payment invalid: ${v.reason ?? "unknown"}` },
    };

  const s = await deps.gateway.settle(payload, req);
  if (!s.success || !s.transaction) {
    return {
      status: 402,
      body: { ...required, error: `settlement failed: ${s.errorReason ?? "unknown"}` },
    };
  }

  const amount = usdcFromAtomic(s.amount ?? req.amount);
  const id = deps.newId();
  const sale: Sale = {
    id,
    takeover_id: id,
    network: deps.cfg.network === BASE_MAINNET ? "mainnet" : "testnet",
    chain: "base",
    asset: "USDC",
    amount,
    usd_value: usdValue(amount),
    tx_hash: s.transaction,
    payer: s.payer ?? "",
    receiver: req.payTo,
    received_at: deps.now(),
    facilitator: facilitatorLabel(deps.cfg.facilitatorUrl),
  };
  const shown: BoardCard = card.card.ticker ? { ...card.card, tokenCheck: tok.status } : card.card;
  return { status: 201, card: shown, logo: logo.logo, sale, settle: s };
}

export const SALE_COLUMNS: (keyof Sale)[] = [
  "id",
  "takeover_id",
  "network",
  "chain",
  "asset",
  "amount",
  "usd_value",
  "tx_hash",
  "payer",
  "receiver",
  "received_at",
  "facilitator",
];

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV for the ledger import. received_at is written as UTC ISO 8601. */
export function salesCsv(rows: Sale[]): string {
  const lines = [SALE_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      SALE_COLUMNS.map((c) =>
        csvCell(c === "received_at" ? new Date(r.received_at).toISOString() : r[c]),
      ).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
