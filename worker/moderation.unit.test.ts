import { describe, expect, it } from "vitest";
import type { BoardCard } from "./card";
import {
  type AiRunner,
  cardText,
  parseGuard,
  parseImageAnswer,
  verdictKey,
  WorkersAiModerator,
} from "./moderation";

const card: BoardCard = {
  name: "Lamp Oil",
  description: "Warm bulb.",
  link: "https://example.com/",
};
const LOGO = "data:image/webp;base64,UklGRg==";

function ai(text: unknown, image: unknown = { response: "SAFE" }): AiRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(model) {
      calls.push(model);
      if (model.includes("llama-guard")) return { response: text };
      return image;
    },
  };
}

describe("moderation parsing", () => {
  it("reads Llama Guard JSON and text answers", () => {
    expect(parseGuard({ safe: true })).toEqual({ ok: true });
    expect(parseGuard({ safe: false, categories: ["S12"] })).toEqual({
      ok: false,
      reason: "content flagged: sexual content",
    });
    expect(parseGuard("unsafe\nS2,S10")).toEqual({
      ok: false,
      reason: "content flagged: non-violent crimes (fraud, scams), hate",
    });
    expect(parseGuard("safe")).toEqual({ ok: true });
  });

  it("fails closed on anything unexpected", () => {
    expect(parseGuard(undefined)).toEqual({ ok: "unavailable" });
    expect(parseGuard({})).toEqual({ ok: "unavailable" });
    expect(parseGuard("maybe")).toEqual({ ok: "unavailable" });
    expect(parseImageAnswer("I can't tell")).toEqual({ ok: "unavailable" });
    expect(parseImageAnswer(42)).toEqual({ ok: "unavailable" });
  });

  it("reads the image answer", () => {
    expect(parseImageAnswer(" safe ")).toEqual({ ok: true });
    expect(parseImageAnswer("UNSAFE.").ok).toBe(false);
  });

  it("describes the card for the classifier", () => {
    const t = cardText({ ...card, x: "lamp", ticker: "LAMPO", chain: "base", contract: "0x1" });
    expect(t).toContain("Display name: Lamp Oil");
    expect(t).toContain("Token: $LAMPO on base");
    expect(t).toContain("X handle: @lamp");
  });
});

describe("WorkersAiModerator", () => {
  it("passes a safe card without a logo and skips the image model", async () => {
    const a = ai({ safe: true });
    expect(await new WorkersAiModerator(a).check(card, null)).toEqual({ ok: true });
    expect(a.calls).toHaveLength(1);
  });

  it("rejects an unsafe logo even when the text is fine", async () => {
    const a = ai({ safe: true }, { response: "UNSAFE" });
    const v = await new WorkersAiModerator(a).check(card, LOGO);
    expect(v.ok).toBe(false);
  });

  it("fails closed when Workers AI throws (for example, the daily quota is used up)", async () => {
    const a: AiRunner = {
      run: async () => {
        throw new Error("4006: daily free allocation exceeded");
      },
    };
    expect(await new WorkersAiModerator(a).check(card, LOGO)).toEqual({ ok: "unavailable" });
  });

  it("keys verdicts by card and logo", async () => {
    const a = await verdictKey(card, null);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await verdictKey(card, null)).toBe(a);
    expect(await verdictKey(card, LOGO)).not.toBe(a);
    expect(await verdictKey({ ...card, name: "Other" }, null)).not.toBe(a);
  });
});
