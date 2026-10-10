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
import type { LinkCheck } from "./links";
import { type Logo, parseLogo } from "./logo";
import type { Verdict } from "./moderation";
import type { TokenCheck } from "./tokens";

export const BASE_MAINNET = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";
const USDC_DECIMALS = 6;
const FACILITATOR_TIMEOUT_MS = 30_000;
/** Seconds a signature must have left after verify, before the slow checks run. */
export const MIN_SECONDS_BEFORE_CHECKS = 30;
/** Seconds a signature must have left right before settle. */
export const MIN_SECONDS_BEFORE_SETTLE = 15;

/**
 * The signature's deadline in unix seconds: Permit2 `deadline` when the payload is Permit2
 * (the facilitator picks Permit2 whenever that key exists, so we must read the same one),
 * otherwise EIP-3009 `validBefore`. null if it has neither, or both, which is refused rather
 * than waved through. Huge values ("never expires") are clamped, not refused.
 */
export function paymentDeadline(payload: PaymentPayload): number | null {
  const p = payload.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  const permit2 = "permit2Authorization" in p;
  if (permit2 && "authorization" in p) return null;
  const raw = permit2
    ? (p.permit2Authorization as { deadline?: unknown } | null)?.deadline
    : (p.authorization as { validBefore?: unknown } | null)?.validBefore;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(text)) return null;
  const n = BigInt(text);
  if (n <= 0n) return null;
  return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
}

/** Facilitator reasons meaning the transfer was mined and reverted: no money moved. */
const REVERTED = new Set(["invalid_exact_evm_transaction_failed", "invalid_transaction_state"]);
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

type SettleOutcome =
  | { kind: "settled"; s: SettleResponse & { transaction: string } }
  | { kind: "refused"; reason: string }
  | { kind: "unknown"; tx: string | null; why: string };

/**
 * What a settle call means for the buyer. Only two shapes prove no money moved: a refusal
 * with no transaction (returned, or thrown as a 4xx SettleError), and a transaction that was
 * mined and reverted. Everything else that isn't a success (pending, timeouts, 5xx, network
 * errors, "success" with no tx, a receipt that doesn't match) may have moved money.
 */
export function classifySettle(
  r: { ok: true; s: SettleResponse } | { ok: false; error: unknown },
): SettleOutcome {
  let res: Partial<SettleResponse>;
  let status = 200;
  if (r.ok) {
    res = r.s;
  } else {
    const e = r.error as Partial<SettleResponse> & { name?: string; statusCode?: number };
    if (e?.name !== "SettleError") {
      return {
        kind: "unknown",
        tx: null,
        why: r.error instanceof Error ? r.error.message : String(r.error),
      };
    }
    res = { success: false, errorReason: e.errorReason, transaction: e.transaction };
    status = typeof e.statusCode === "number" ? e.statusCode : 500;
  }
  const tx = typeof res.transaction === "string" && res.transaction ? res.transaction : null;
  const reason = res.errorReason ?? "unknown";
  if (res.success) {
    return tx
      ? { kind: "settled", s: { ...(res as SettleResponse), transaction: tx } }
      : { kind: "unknown", tx: null, why: "success without a transaction" };
  }
  // "Nonce already used" means the authorization was spent, possibly by us (for example the
  // library's retry of a pending settle), so it doesn't prove no money moved.
  if (reason === "settlement_pending" || /nonce|already_used/.test(reason)) {
    return { kind: "unknown", tx, why: reason };
  }
  if (tx) {
    return REVERTED.has(reason) && TX_HASH.test(tx)
      ? { kind: "refused", reason: `${reason} (reverted)` }
      : { kind: "unknown", tx, why: reason };
  }
  return status < 500
    ? { kind: "refused", reason }
    : { kind: "unknown", tx: null, why: `${status} ${reason}` };
}

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
  ): Promise<{ ok: boolean; reason?: string; payer?: string }>;
  settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse>;
}

export class X402Gateway implements Gateway {
  private server: x402ResourceServer;
  private ready: Promise<void> | null = null;

  constructor(private readonly cfg: PayConfig) {
    // 30 s per facilitator call instead of the library's 90 s, so a slow facilitator can't
    // outlast the buyer's 120 s signature.
    this.server = new x402ResourceServer(
      new HTTPFacilitatorClient({ url: cfg.facilitatorUrl, timeoutMs: FACILITATOR_TIMEOUT_MS }),
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
    return { ok: r.isValid, reason: r.invalidReason ?? r.invalidMessage, payer: r.payer };
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
  | { status: 429; body: { error: string }; retryAfter: number }
  | { status: 402; body: PaymentRequired }
  /** Settle didn't confirm, but the transfer may have been broadcast. Never "try again". */
  | { status: 202; body: { error: string; tx: string | null }; detail: string }
  | { status: 201; card: BoardCard; logo: Logo | null; sale: Sale; settle: SettleResponse };

export interface TakeDeps {
  gateway: Gateway;
  cfg: PayConfig;
  now: () => number;
  newId: () => string;
  decodePayment: (header: string) => PaymentPayload;
  /** Moderation for the card and its logo (null if none), charged to the verified payer. */
  moderate: (card: BoardCard, logo: Logo | null, payer: string) => Promise<Verdict>;
  /** DexScreener checks for token cards. */
  checkToken: (card: BoardCard) => Promise<TokenCheck>;
  /** Phishing and look-alike checks on the card's link. */
  checkLink: (link: string) => Promise<LinkCheck>;
  /**
   * Per-wallet and per-listing limits on paid takeovers. `peekPaid` checks without counting
   * (before the slow checks); `commitPaid` counts, right before settle, so attempts that are
   * refused (fake token, flagged content, outages) can't burn anyone's quota. `releasePaid`
   * undoes a commit (same `at`) when settlement fails, so a replayed signature can't either.
   */
  peekPaid: (payer: string, card: BoardCard) => Promise<{ ok: boolean; retryAfter: number }>;
  commitPaid: (
    payer: string,
    card: BoardCard,
    at: number,
  ) => Promise<{ ok: boolean; retryAfter: number }>;
  releasePaid: (payer: string, card: BoardCard, at: number) => Promise<void>;
}

function unknownOutcome(tx: string | null, payer: string, why: string): TakeResult {
  const ref = tx ? ` (transaction ${tx})` : "";
  return {
    status: 202,
    body: {
      error:
        `We could not confirm your payment${ref}. It may still go through, so do not pay again. ` +
        "Check your wallet in a few minutes. If 1 USDC left it and your card is not in the " +
        "queue, contact us with the transaction hash and we will queue your card or refund you.",
      tx,
    },
    detail: `payer ${payer}: ${why}`,
  };
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
  // 1. Cheap checks only. An unpaid quote never spends AI or DexScreener calls, so it can't be
  //    used to burn the daily moderation budget or trip third-party rate limits.
  const card = validateCard(body);
  const logo = parseLogo((body as { logo?: unknown } | null)?.logo);
  const errors = [...(card.ok ? [] : card.errors), ...(logo.ok ? [] : [logo.error])];
  if (!card.ok || !logo.ok) return { status: 400, body: { errors } };

  const link = await deps.checkLink(card.card.link);
  if (!link.ok) return { status: 400, body: { errors: [link.reason] } };

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

  // 2. Verify the signed payment. Free, moves no money, and proves who the payer is.
  const v = await deps.gateway.verify(payload, req);
  if (!v.ok)
    return {
      status: 402,
      body: { ...required, error: `payment invalid: ${v.reason ?? "unknown"}` },
    };

  // The facilitator's verified payer covers every payload shape (EIP-3009 and Permit2).
  const claimed = (payload.payload as { authorization?: { from?: string } })?.authorization?.from;
  const payer = (v.payer ?? claimed ?? "").toLowerCase();
  if (!payer) return { status: 402, body: { ...required, error: "payment has no payer" } };

  // Paying yourself moves no money and would log a fake sale.
  if (payer === req.payTo.toLowerCase()) {
    return {
      status: 402,
      body: {
        ...required,
        error: "the payer is the receiving wallet; pay from a different wallet",
      },
    };
  }

  // The signature must outlast the slow checks below, or they'd run (and spend the AI budget)
  // for a payment that can never settle.
  const notCharged = "You have not been charged.";
  const deadline = paymentDeadline(payload);
  const expiring = (minSeconds: number) =>
    deadline === null || deadline * 1000 - deps.now() < minSeconds * 1000;
  if (expiring(MIN_SECONDS_BEFORE_CHECKS)) {
    return {
      status: 402,
      body: { ...required, error: `Your payment signature expired. Sign again. ${notCharged}` },
    };
  }

  // 3. Limits on the verified payer, so nobody can burn another wallet's or listing's quota
  //    with forged headers. Peek only: nothing is counted until the checks below pass.
  const lim = await deps.peekPaid(payer, card.card);
  if (!lim.ok) {
    return {
      status: 429,
      body: { error: "Too many takeovers from this wallet or for this listing. Try again later." },
      retryAfter: lim.retryAfter,
    };
  }

  // 4. Token checks and moderation, still before any money moves.
  const tok = await deps.checkToken(card.card);
  if (!tok.ok) {
    if (tok.unavailable) {
      return {
        status: 503,
        body: {
          error: `Token checks are unavailable right now. Try again in a minute. ${notCharged}`,
        },
      };
    }
    return { status: 400, body: { errors: [`token check: ${tok.reason}. ${notCharged}`] } };
  }

  const verdict = await deps.moderate(card.card, logo.logo, payer);
  if (verdict.ok === "unavailable") {
    return {
      status: 503,
      body: { error: `Moderation is unavailable right now. Try again later. ${notCharged}` },
    };
  }
  if (!verdict.ok) {
    return { status: 400, body: { errors: [`rejected: ${verdict.reason}. ${notCharged}`] } };
  }

  // Checked again before counting, so a signature that ran out during the checks can't burn
  // a listing's quota, and we never start a settle that can't finish.
  if (expiring(MIN_SECONDS_BEFORE_SETTLE)) {
    return {
      status: 402,
      body: { ...required, error: `Your payment signature expired. Sign again. ${notCharged}` },
    };
  }

  // 5. Count the limits now that every check passed (refused if another request got there).
  const committedAt = deps.now();
  const commit = await deps.commitPaid(payer, card.card, committedAt);
  if (!commit.ok) {
    return {
      status: 429,
      body: {
        error: `Too many takeovers from this wallet or for this listing. Try again later. ${notCharged}`,
      },
      retryAfter: commit.retryAfter,
    };
  }

  // 6. Settle. Only now does money move. Unless the result proves no money moved (see
  // classifySettle), the buyer is told not to pay again and the counts stay.
  const outcome = classifySettle(
    await deps.gateway.settle(payload, req).then(
      (s) => ({ ok: true as const, s }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  );
  if (outcome.kind === "unknown") return unknownOutcome(outcome.tx, payer, outcome.why);
  if (outcome.kind === "refused") {
    await deps.releasePaid(payer, card.card, committedAt);
    return {
      status: 402,
      body: { ...required, error: `settlement failed: ${outcome.reason}. ${notCharged}` },
    };
  }
  const s = outcome.s;

  // The facilitator's amount if it is atomic units, else the quoted one: nothing after a
  // successful settle may throw, or the buyer would be told to try again.
  const amount = usdcFromAtomic(/^\d+$/.test(s.amount ?? "") ? (s.amount as string) : req.amount);
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
    payer: s.payer ?? payer,
    receiver: req.payTo,
    received_at: deps.now(),
    facilitator: facilitatorLabel(deps.cfg.facilitatorUrl),
  };
  return { status: 201, card: card.card, logo: logo.logo, sale, settle: s };
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
