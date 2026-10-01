import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  BASE_SEPOLIA,
  type Gateway,
  type PayConfig,
  processTake,
  type Sale,
  salesCsv,
  type TakeDeps,
  usdcFromAtomic,
  usdValue,
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
      return { ok: true };
    },
    async settle() {
      calls.push("settle");
      return { success: true, transaction: "0xabc", network: BASE_SEPOLIA, payer: "0xpayer" };
    },
    ...over,
  };
}

function deps(gateway: Gateway, payload: Partial<PaymentPayload> = {}): TakeDeps {
  return {
    gateway,
    cfg,
    now: () => 1_790_000_000_000,
    newId: () => "sale-1",
    decodePayment: () => ({ x402Version: 2, accepted: req, payload: {}, ...payload }),
    moderate: async () => ({ ok: true }),
    checkToken: async () => ({ ok: true, status: "verified" }),
  };
}

describe("processTake", () => {
  it("rejects a bad card before asking for payment", async () => {
    const g = fake();
    const r = await processTake(deps(g), { name: "" }, null, "u");
    expect(r.status).toBe(400);
    expect(g.calls).toEqual([]);
  });

  it("rejects a fake token before moderation or quoting", async () => {
    const g = fake();
    let moderated = false;
    const d = {
      ...deps(g),
      checkToken: async () => ({ ok: false as const, reason: "this contract looks like a copy" }),
      moderate: async () => {
        moderated = true;
        return { ok: true as const };
      },
    };
    const r = await processTake(d, card, null, "u");
    expect(r.status).toBe(400);
    expect(r.status === 400 && r.body.errors[0]).toMatch(/token check: .*copy/);
    expect(moderated).toBe(false);
    expect(g.calls).toEqual([]);
  });

  it("rejects a flagged card before quoting a price", async () => {
    const g = fake();
    const d = {
      ...deps(g),
      moderate: async () => ({ ok: false as const, reason: "content flagged: hate" }),
    };
    const r = await processTake(d, card, null, "u");
    expect(r.status).toBe(400);
    expect(r.status === 400 && r.body.errors[0]).toMatch(/hate/);
    expect(g.calls).toEqual([]);
  });

  it("asks the buyer to retry, uncharged, when moderation is unavailable", async () => {
    const g = fake();
    const d = { ...deps(g), moderate: async () => ({ ok: "unavailable" as const }) };
    const r = await processTake(d, card, "x", "u");
    expect(r.status).toBe(503);
    expect(r.status === 503 && r.body.error).toMatch(/not been charged/);
    expect(g.calls).toEqual([]);
  });

  it("answers 402 with the price when there is no payment", async () => {
    const r = await processTake(deps(fake()), card, null, "u");
    expect(r.status).toBe(402);
    expect(r.status === 402 && r.body.accepts[0].amount).toBe("1000000");
  });

  it("rejects a payment for a different amount or receiver", async () => {
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
    expect(g.calls).not.toContain("settle");
  });

  it("rejects a payment from the receiving wallet itself", async () => {
    const g = fake();
    const r = await processTake(
      deps(g, { payload: { authorization: { from: PAY_TO.toUpperCase().replace("0X", "0x") } } }),
      card,
      "x",
      "u",
    );
    expect(r.status).toBe(402);
    expect(r.status === 402 && r.body.error).toMatch(/receiving wallet/);
    expect(g.calls).not.toContain("verify");
  });

  it("does not settle a payment that fails verification", async () => {
    const g = fake({ verify: async () => ({ ok: false, reason: "insufficient_funds" }) });
    const r = await processTake(deps(g), card, "x", "u");
    expect(r.status).toBe(402);
    expect(r.status === 402 && r.body.error).toMatch(/insufficient_funds/);
    expect(g.calls).not.toContain("settle");
  });

  it("does not queue when settlement fails", async () => {
    const g = fake({
      settle: async () => ({
        success: false,
        errorReason: "nonce_used",
        transaction: "",
        network: BASE_SEPOLIA,
      }),
    });
    const r = await processTake(deps(g), card, "x", "u");
    expect(r.status).toBe(402);
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
      received_at: 1_790_000_000_000,
      facilitator: "x402.org",
    });
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
