import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  BASE_SEPOLIA,
  classifySettle,
  type Gateway,
  type PayConfig,
  paymentDeadline,
  processTake,
  type Sale,
  salesCsv,
  type TakeDeps,
  usdcFromAtomic,
  usdValue,
  WatchedFacilitator,
} from "./pay";

const PAY_TO = "0x00000000000000000000000000000000000000aa";
const cfg: PayConfig = {
  network: BASE_SEPOLIA,
  payTo: PAY_TO,
  priceUsd: "1",
  facilitatorUrl: "https://x402.org/facilitator",
};
const req: PaymentRequirements = {
  scheme: "exact",
  network: BASE_SEPOLIA,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "1000000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: {},
};
const required: PaymentRequired = {
  x402Version: 2,
  resource: { url: "https://board.test/api/take" },
  accepts: [req],
};
const card = { name: "Lamp Oil", description: "Warm bulb.", link: "https://example.com" };
const NOW = 1_790_000_000_000;
const NOW_SEC = NOW / 1000;
/** A normal EIP-3009 payload: signed just now, valid for 120 s. */
const auth = (over: Record<string, string> = {}) => ({
  authorization: { validBefore: String(NOW_SEC + 120), ...over },
});

function fake(over: Partial<Gateway> = {}): Gateway & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async requirements() {
      calls.push("requirements");
      return required;
    },
    async verify() {
      calls.push("verify");
      return { ok: true, payer: "0xbuyer" };
    },
    async settle() {
      calls.push("settle");
      return { success: true, transaction: "0xabc", network: BASE_SEPOLIA, payer: "0xpayer" };
    },
    ...over,
  };
}

/** Records which expensive checks ran. */
function deps(
  gateway: Gateway,
  payload: Partial<PaymentPayload> = {},
): TakeDeps & { ran: string[]; limitedPayer: string[]; clock: { t: number }; ats: number[] } {
  const ran: string[] = [];
  const limitedPayer: string[] = [];
  const clock = { t: NOW };
  const ats: number[] = [];
  return {
    ran,
    limitedPayer,
    clock,
    ats,
    gateway,
    cfg,
    now: () => clock.t,
    newId: () => "sale-1",
    decodePayment: () => ({ x402Version: 2, accepted: req, payload: auth(), ...payload }),
    moderate: async (_card, _logo, payer) => {
      ran.push(`moderate:${payer}`);
      return { ok: true };
    },
    checkToken: async () => {
      ran.push("token");
      return { ok: true };
    },
    checkLink: async () => {
      ran.push("link");
      return { ok: true };
    },
    peekPaid: async (payer) => {
      ran.push("peek");
      limitedPayer.push(payer);
      return { ok: true, retryAfter: 0 };
    },
    commitPaid: async (payer, _card, at) => {
      ran.push("commit");
      limitedPayer.push(payer);
      ats.push(at);
      return { ok: true, retryAfter: 0 };
    },
    releasePaid: async (_payer, _card, at) => {
      ran.push("release");
      ats.push(at);
    },
  };
}

describe("processTake", () => {
  it("rejects a bad card before asking for payment", async () => {
    const g = fake();
    const r = await processTake(deps(g), { name: "" }, null, "u");
    expect(r.status).toBe(400);
    expect(g.calls).toEqual([]);
  });

  it("rejects a phishing link before quoting", async () => {
    const g = fake();
    const d = {
      ...deps(g),
      checkLink: async () => ({
        ok: false as const,
        reason: "link: this domain is on a phishing blocklist",
      }),
    };
    const r = await processTake(d, card, null, "u");
    expect(r.status).toBe(400);
    expect(r.status === 400 && r.body.errors[0]).toMatch(/phishing blocklist/);
    expect(g.calls).toEqual([]);
  });

  it("quotes after cheap checks only: no AI, no DexScreener, no facilitator verify", async () => {
    const g = fake();
    const d = deps(g);
    const r = await processTake(d, card, null, "u");
    expect(r.status).toBe(402);
    expect(r.status === 402 && r.body.accepts[0].amount).toBe("1000000");
    expect(d.ran).toEqual(["link"]);
    expect(g.calls).toEqual(["requirements"]);
  });

  it("runs the full order on a paid request: verify, limits, token, moderation, settle", async () => {
    const g = fake();
    const d = deps(g);
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(201);
    expect(d.ran).toEqual(["link", "peek", "token", "moderate:0xbuyer", "commit"]);
    expect(g.calls).toEqual(["requirements", "verify", "settle"]);
  });

  it("applies limits to the facilitator-verified payer, not the claimed one", async () => {
    const g = fake();
    const d = deps(g, { payload: auth({ from: "0xvictim" }) });
    await processTake(d, card, "x", "u");
    expect(d.limitedPayer).toEqual(["0xbuyer", "0xbuyer"]);
  });

  it("never counts limits for a payment that fails verification", async () => {
    const g = fake({ verify: async () => ({ ok: false, reason: "invalid_signature" }) });
    const d = deps(g, { payload: auth({ from: "0xvictim" }) });
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(402);
    expect(d.ran).not.toContain("peek");
    expect(d.ran).not.toContain("commit");
    expect(g.calls).not.toContain("settle");
  });

  it("refuses a wallet over its limit after verify and before settle", async () => {
    const g = fake();
    const d = { ...deps(g), peekPaid: async () => ({ ok: false, retryAfter: 120 }) };
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(429);
    expect(r.status === 429 && r.retryAfter).toBe(120);
    expect(g.calls).not.toContain("settle");
  });

  it("rejects a fake token after verify, uncharged, without running moderation", async () => {
    const g = fake();
    const d = deps(g);
    const r = await processTake(
      {
        ...d,
        checkToken: async () => ({ ok: false as const, reason: "this contract looks like a copy" }),
      },
      card,
      "x",
      "u",
    );
    expect(r.status).toBe(400);
    expect(r.status === 400 && r.body.errors[0]).toMatch(/token check: .*copy.*not been charged/);
    expect(d.ran.some((x) => x.startsWith("moderate"))).toBe(false);
    expect(d.ran).not.toContain("commit");
    expect(g.calls).not.toContain("settle");
  });

  it("refuses token cards, uncharged, when DexScreener is unavailable", async () => {
    const g = fake();
    const d = {
      ...deps(g),
      checkToken: async () => ({
        ok: false as const,
        reason: "unavailable",
        unavailable: true as const,
      }),
    };
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(503);
    expect(r.status === 503 && r.body.error).toMatch(/not been charged/);
    expect(g.calls).not.toContain("settle");
  });

  it("rejects a flagged card after verify, uncharged", async () => {
    const g = fake();
    const d = {
      ...deps(g),
      moderate: async () => ({ ok: false as const, reason: "content flagged: hate" }),
    };
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(400);
    expect(r.status === 400 && r.body.errors[0]).toMatch(/hate.*not been charged/);
    expect(g.calls).not.toContain("settle");
  });

  it("never counts limits for attempts refused by token checks or moderation", async () => {
    for (const over of [
      { checkToken: async () => ({ ok: false as const, reason: "copy" }) },
      { moderate: async () => ({ ok: false as const, reason: "flagged" }) },
      { moderate: async () => ({ ok: "unavailable" as const }) },
    ]) {
      const g = fake();
      const d = deps(g);
      await processTake({ ...d, ...over }, card, "x", "u");
      expect(d.ran).not.toContain("commit");
    }
  });

  it("refuses, uncharged, if another request took the last slot before settle", async () => {
    const g = fake();
    const d = { ...deps(g), commitPaid: async () => ({ ok: false, retryAfter: 60 }) };
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(429);
    expect(g.calls).not.toContain("settle");
  });

  it("refuses a short-lived signature before any slow check or count", async () => {
    // The facilitator accepts anything 6 s ahead; we need 30 s before spending AI or quota.
    for (const left of [5, 10, 29]) {
      const g = fake();
      const d = deps(g, { payload: auth({ validBefore: String(NOW_SEC + left) }) });
      const r = await processTake(d, card, "x", "u");
      expect(r.status).toBe(402);
      expect(r.status === 402 && r.body.error).toMatch(/expired.*not been charged/);
      expect(d.ran).toEqual(["link"]);
      expect(g.calls).not.toContain("settle");
    }
  });

  it("refuses, uncounted, a signature that ran out during the checks", async () => {
    const g = fake();
    const d = deps(g, { payload: auth({ validBefore: String(NOW_SEC + 40) }) });
    const slow = {
      ...d,
      moderate: async () => {
        d.clock.t += 30_000; // 10 s left afterwards
        return { ok: true as const };
      },
    };
    const r = await processTake(slow, card, "x", "u");
    expect(r.status).toBe(402);
    expect(d.ran).not.toContain("commit");
    expect(d.ran).not.toContain("release");
    expect(g.calls).not.toContain("settle");
  });

  it("refuses a mixed payload whose real (Permit2) deadline is too short", async () => {
    const g = fake();
    const d = deps(g, {
      payload: {
        authorization: { validBefore: "9999999999" },
        permit2Authorization: { deadline: String(NOW_SEC + 10) },
      },
    });
    expect((await processTake(d, card, "x", "u")).status).toBe(402);
    expect(d.ran).toEqual(["link"]);
  });

  it("refuses a payload with no deadline instead of skipping the check", async () => {
    const g = fake();
    const r = await processTake(deps(g, { payload: {} }), card, "x", "u");
    expect(r.status).toBe(402);
    expect(g.calls).not.toContain("settle");
  });

  it("reads the Permit2 deadline too", async () => {
    const short = deps(fake(), {
      payload: { permit2Authorization: { deadline: String(NOW_SEC + 10) } },
    });
    expect((await processTake(short, card, "x", "u")).status).toBe(402);
    const ok = deps(fake(), {
      payload: { permit2Authorization: { deadline: String(NOW_SEC + 120) } },
    });
    expect((await processTake(ok, card, "x", "u")).status).toBe(201);
  });

  it("asks the buyer to retry, uncharged, when moderation is unavailable", async () => {
    const g = fake();
    const d = { ...deps(g), moderate: async () => ({ ok: "unavailable" as const }) };
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(503);
    expect(r.status === 503 && r.body.error).toMatch(/not been charged/);
    expect(g.calls).not.toContain("settle");
  });

  it("rejects a payment for a different amount or receiver without calling the facilitator", async () => {
    const g = fake();
    const cheap = await processTake(deps(g, { accepted: { ...req, amount: "1" } }), card, "x", "u");
    expect(cheap.status).toBe(402);
    const elsewhere = await processTake(
      deps(g, { accepted: { ...req, payTo: "0x00000000000000000000000000000000000000bb" } }),
      card,
      "x",
      "u",
    );
    expect(elsewhere.status).toBe(402);
    expect(g.calls).not.toContain("verify");
    expect(g.calls).not.toContain("settle");
  });

  it("rejects a payment from the receiving wallet itself (verified payer)", async () => {
    const g = fake({
      verify: async () => ({ ok: true, payer: PAY_TO.toUpperCase().replace("0X", "0x") }),
    });
    const r = await processTake(deps(g), card, "x", "u");
    expect(r.status).toBe(402);
    expect(r.status === 402 && r.body.error).toMatch(/receiving wallet/);
    expect(g.calls).not.toContain("settle");
  });

  it("does not queue when settlement is refused, and gives the quota back", async () => {
    const g = fake({
      settle: async () => ({
        success: false,
        errorReason: "invalid_exact_evm_insufficient_balance",
        transaction: "",
        network: BASE_SEPOLIA,
      }),
    });
    const d = deps(g);
    const slowSettle = {
      ...d,
      gateway: {
        ...g,
        settle: async (...a: Parameters<Gateway["settle"]>) => {
          d.clock.t += 5_000; // the release must undo the same window the commit used
          return g.settle(...a);
        },
      },
    };
    const r = await processTake(slowSettle, card, "x", "u");
    expect(r.status).toBe(402);
    expect(r.status === 402 && r.body.error).toMatch(/not been charged/);
    expect(d.ran.slice(-2)).toEqual(["commit", "release"]);
    expect(d.ats[0]).toBe(d.ats[1]);
  });

  it("gives the quota back for a refusal thrown as a 4xx SettleError with no tx", async () => {
    const g = fake({
      settle: async () => {
        throw Object.assign(new Error("invalid_exact_evm_signature"), {
          name: "SettleError",
          statusCode: 400,
          errorReason: "invalid_exact_evm_signature",
          transaction: "",
        });
      },
    });
    const d = deps(g);
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(402);
    expect(d.ran.slice(-2)).toEqual(["commit", "release"]);
  });

  it("never says 'not charged' for 'transaction failed', with or without a tx", async () => {
    // The facilitator uses this reason for a broadcast that errored (which may still mine)
    // and for a pending tx it couldn't store, as well as for a revert.
    for (const transaction of [`0x${"ab".repeat(32)}`, ""]) {
      const g = fake({
        settle: async () => ({
          success: false,
          errorReason: "invalid_exact_evm_transaction_failed",
          transaction,
          network: BASE_SEPOLIA,
        }),
      });
      const d = deps(g);
      expect((await processTake(d, card, "x", "u")).status).toBe(202);
      expect(d.ran).not.toContain("release");
    }
  });

  it("says 'unknown' when an earlier attempt broadcast, even if the last one looks refused", async () => {
    // The library retries a pending settle once and returns only the second result.
    const g = fake({
      settle: async () => ({
        success: false,
        errorReason: "invalid_exact_evm_payload_authorization_valid_before",
        transaction: "",
        network: BASE_SEPOLIA,
      }),
      settleTrace: () => ({ broadcast: true, firstTx: "0xfirst" }),
    });
    const d = deps(g);
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(202);
    expect(r.status === 202 && r.body.tx).toBe("0xfirst");
    expect(d.ran).not.toContain("release");
  });

  it("records the sale even if the facilitator's amount isn't atomic units", async () => {
    const g = fake({
      settle: async () => ({
        success: true,
        transaction: "0xabc",
        network: BASE_SEPOLIA,
        amount: "1.00",
      }),
    });
    const r = await processTake(deps(g), card, "x", "u");
    expect(r.status).toBe(201);
    expect(r.status === 201 && r.sale.amount).toBe("1.000000");
  });

  it("never says 'try again' when settle errors: the transfer may have gone out", async () => {
    const g = fake({
      settle: async () => {
        throw new Error("facilitator timeout");
      },
    });
    const d = deps(g);
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(202);
    expect(r.status === 202 && r.body.error).toMatch(/do not pay again/);
    expect(r.status === 202 && r.detail).toMatch(/0xbuyer.*facilitator timeout/);
    // The counts stay: this may be a real payment.
    expect(d.ran).not.toContain("release");
  });

  it("treats settlement_pending with a tx hash as unknown, not failed", async () => {
    const g = fake({
      settle: async () => ({
        success: false,
        errorReason: "settlement_pending",
        transaction: "0xpending",
        network: BASE_SEPOLIA,
      }),
    });
    const d = deps(g);
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(202);
    expect(r.status === 202 && r.body.tx).toBe("0xpending");
    expect(r.status === 202 && r.body.error).toMatch(/0xpending.*do not pay again/);
    expect(d.ran).not.toContain("release");
  });

  it("keeps the quota counted after a successful settle", async () => {
    const d = deps(fake());
    await processTake(d, card, "x", "u");
    expect(d.ran).not.toContain("release");
  });

  it("builds the sale row after settlement", async () => {
    const r = await processTake(deps(fake()), card, "x", "u");
    expect(r.status).toBe(201);
    if (r.status !== 201) return;
    expect(r.card.name).toBe("Lamp Oil");
    expect(r.sale).toEqual({
      id: "sale-1",
      takeover_id: "sale-1",
      network: "testnet",
      chain: "base",
      asset: "USDC",
      amount: "1.000000",
      usd_value: "1.00",
      tx_hash: "0xabc",
      payer: "0xpayer",
      receiver: PAY_TO,
      received_at: NOW,
      facilitator: "x402.org",
    });
  });
});

describe("classifySettle", () => {
  const ok = (s: object, trace?: { broadcast: boolean; firstTx: string | null }) =>
    classifySettle({ ok: true, s: { network: BASE_SEPOLIA, ...s } as never }, trace);
  const thrown = (e: object) =>
    classifySettle({ ok: false, error: Object.assign(new Error("x"), e) });
  const hash = `0x${"cd".repeat(32)}`;
  const preBroadcast = "invalid_exact_evm_payload_authorization_valid_before";

  it("only treats a pre-broadcast refusal with no tx as proof of no transfer", () => {
    expect(ok({ success: true, transaction: "0xabc" }).kind).toBe("settled");
    expect(ok({ success: false, transaction: "", errorReason: preBroadcast }).kind).toBe("refused");
    expect(
      thrown({ name: "SettleError", statusCode: 400, errorReason: preBroadcast, transaction: "" })
        .kind,
    ).toBe("refused");
  });

  it("treats everything else as unknown, keeping the first tx hash", () => {
    for (const s of [
      { success: true, transaction: "" },
      { success: false, transaction: "0xp", errorReason: "settlement_pending" },
      { success: false, transaction: hash, errorReason: "invalid_exact_evm_transaction_failed" },
      { success: false, transaction: "", errorReason: "invalid_exact_evm_transaction_failed" },
      { success: false, transaction: "", errorReason: "invalid_exact_evm_nonce_already_used" },
      {
        success: false,
        transaction: hash,
        errorReason: "invalid_exact_evm_transfer_event_mismatch",
      },
      { success: false, transaction: "", errorReason: "erc20_approval_broadcast_failed" },
      { success: false, transaction: "", errorReason: "some_other_facilitator_reason" },
      { success: false, transaction: "", errorReason: preBroadcast, extra: 1 },
    ]) {
      const trace = "extra" in s ? { broadcast: true, firstTx: "0xfirst" } : undefined;
      expect(ok(s, trace).kind, JSON.stringify(s)).toBe("unknown");
    }
    expect(
      ok({ success: false, transaction: "0xp", errorReason: "settlement_pending" }),
    ).toMatchObject({ tx: "0xp" });
    expect(
      ok(
        { success: false, transaction: "", errorReason: preBroadcast },
        { broadcast: true, firstTx: "0xfirst" },
      ),
    ).toMatchObject({ kind: "unknown", tx: "0xfirst" });
    expect(
      thrown({
        name: "SettleError",
        statusCode: 400,
        errorReason: "settlement_pending",
        transaction: "0xq",
      }),
    ).toMatchObject({ kind: "unknown", tx: "0xq" });
    expect(
      thrown({ name: "SettleError", statusCode: 502, errorReason: preBroadcast, transaction: "" })
        .kind,
    ).toBe("unknown");
    expect(thrown({ name: "FacilitatorTimeoutError" }).kind).toBe("unknown");
    expect(classifySettle({ ok: false, error: new TypeError("fetch failed") }).kind).toBe(
      "unknown",
    );
  });
});

describe("WatchedFacilitator", () => {
  const payload = { x402Version: 2, accepted: req, payload: { signature: "0xsig" } } as never;
  const other = { x402Version: 2, accepted: req, payload: { signature: "0xother" } } as never;
  const inner = (results: (object | Error)[]) => {
    let i = 0;
    return {
      verify: async () => ({ isValid: true }),
      getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
      settle: async () => {
        const r = results[i++];
        if (r instanceof Error) throw r;
        return r;
      },
    } as never;
  };

  it("remembers a pending attempt that the library's retry hides", async () => {
    const w = new WatchedFacilitator(
      inner([
        {
          success: false,
          errorReason: "settlement_pending",
          transaction: "0xtx1",
          network: BASE_SEPOLIA,
        },
        {
          success: false,
          errorReason: "invalid_exact_evm_payload_authorization_valid_before",
          transaction: "",
          network: BASE_SEPOLIA,
        },
      ]),
    );
    await w.settle(payload, req);
    await w.settle(payload, req);
    expect(w.trace(payload)).toEqual({ broadcast: true, firstTx: "0xtx1" });
    expect(w.trace(other)).toEqual({ broadcast: false, firstTx: null });
  });

  it("records a tx carried by a thrown SettleError, and nothing for a plain refusal", async () => {
    const err = Object.assign(new Error("settlement_pending"), {
      name: "SettleError",
      errorReason: "settlement_pending",
      transaction: "0xtx2",
    });
    const w = new WatchedFacilitator(
      inner([
        err,
        {
          success: false,
          errorReason: "invalid_exact_evm_signature",
          transaction: "",
          network: BASE_SEPOLIA,
        },
      ]),
    );
    await expect(w.settle(payload, req)).rejects.toThrow();
    expect(w.trace(payload)).toEqual({ broadcast: true, firstTx: "0xtx2" });
    await w.settle(other, req);
    expect(w.trace(other)).toEqual({ broadcast: false, firstTx: null });
  });
});

describe("paymentDeadline", () => {
  const p = (payload: unknown) =>
    paymentDeadline({ x402Version: 2, accepted: req, payload } as never);

  it("reads the field the facilitator will use", () => {
    expect(p({ authorization: { validBefore: "1790000120" } })).toBe(1_790_000_120);
    expect(p({ permit2Authorization: { deadline: 1_790_000_120 } })).toBe(1_790_000_120);
    expect(p({ authorization: { validBefore: "0x6ab0c0f8" } })).toBe(0x6ab0c0f8);
  });

  it("refuses a payload with both shapes (the facilitator would use Permit2)", () => {
    expect(
      p({
        authorization: { validBefore: "9999999999" },
        permit2Authorization: { deadline: "1790000010" },
      }),
    ).toBeNull();
  });

  it("clamps 'never expires' values instead of refusing them", () => {
    expect(p({ authorization: { validBefore: (2n ** 256n - 1n).toString() } })).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("refuses junk", () => {
    for (const v of ["", "1e3", "-5", "0", null, {}]) {
      expect(p({ authorization: { validBefore: v } }), String(v)).toBeNull();
    }
    expect(p({})).toBeNull();
    expect(p(null)).toBeNull();
  });
});

describe("money formatting", () => {
  it("converts atomic USDC without floats", () => {
    expect(usdcFromAtomic("1000000")).toBe("1.000000");
    expect(usdcFromAtomic("1")).toBe("0.000001");
    expect(usdcFromAtomic("123456789")).toBe("123.456789");
    expect(() => usdcFromAtomic("1.5")).toThrow();
  });

  it("rounds USD to cents", () => {
    expect(usdValue("1.000000")).toBe("1.00");
    expect(usdValue("0.004999")).toBe("0.00");
    expect(usdValue("0.005000")).toBe("0.01");
    expect(usdValue("12.345678")).toBe("12.35");
  });
});

describe("salesCsv", () => {
  it("writes a header and ISO timestamps, and escapes cells", () => {
    const sale: Sale = {
      id: "a",
      takeover_id: "a",
      network: "testnet",
      chain: "base",
      asset: "USDC",
      amount: "1.000000",
      usd_value: "1.00",
      tx_hash: "0xabc",
      payer: 'x,"y"',
      receiver: "0xr",
      received_at: Date.UTC(2026, 9, 1, 12, 0, 0),
      facilitator: "x402.org",
    };
    const lines = salesCsv([sale]).trim().split("\n");
    expect(lines[0]).toBe(
      "id,takeover_id,network,chain,asset,amount,usd_value,tx_hash,payer,receiver,received_at,facilitator",
    );
    expect(lines[1]).toBe(
      'a,a,testnet,base,USDC,1.000000,1.00,0xabc,"x,""y""",0xr,2026-10-01T12:00:00.000Z,x402.org',
    );
  });
});
