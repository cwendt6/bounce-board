import { describe, expect, it } from "vitest";
import { paidOutcome } from "./pay-client";

describe("paidOutcome (reply to a signed payment)", () => {
  it("is done on 201 with a tx", () => {
    expect(paidOutcome(201, { tx: "0xabc" })).toEqual({ kind: "ok", tx: "0xabc" });
  });

  it("never lets the buyer pay again when money may have moved", () => {
    const pending = [
      paidOutcome(201, null), // paid, but the body was lost
      paidOutcome(202, { error: "We could not confirm your payment. Do not pay again.", tx: null }),
      paidOutcome(500, {
        error: "Your payment went through, but your card was not queued. Do not pay again.",
        tx: "0xdef",
      }),
      paidOutcome(502, { error: "payment service unavailable, try again" }),
      paidOutcome(500, null), // a platform error page
    ];
    for (const p of pending) expect(p.kind).toBe("pending");
    expect(pending[2]).toMatchObject({ tx: "0xdef" });
    expect(pending[3].kind === "pending" && pending[3].message).toMatch(/Do not pay again/);
  });

  it("lets the buyer fix and retry after an explicit refusal", () => {
    for (const [status, body] of [
      [400, { errors: ["rejected: content flagged. You have not been charged."] }],
      [402, { error: "Your payment signature expired. Sign again. You have not been charged." }],
      [429, { error: "Too many takeovers. Try again later." }],
      [503, { error: "Moderation is unavailable right now. You have not been charged." }],
    ] as const) {
      expect(paidOutcome(status, body).kind, String(status)).toBe("error");
    }
  });
});
