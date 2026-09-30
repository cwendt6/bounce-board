import { describe, expect, it } from "vitest";
import { validateCard } from "./card";

const base = { name: "Lamp Oil", description: "Warm bulb.", link: "https://example.com/lamp" };

describe("validateCard", () => {
  it("accepts a plain brand card and assigns a color", () => {
    const r = validateCard(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.name).toBe("Lamp Oil");
      expect(r.card.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(r.card.ticker).toBeUndefined();
    }
  });

  it("normalizes token fields", () => {
    const r = validateCard({
      ...base,
      x: "@lamp_oil",
      ticker: "$lampo",
      chain: "Base",
      contract: "0x7a3f9c21d04e5b8a6f1e2d3c4b5a69788f1e2d3c",
    });
    expect(r.ok && r.card).toMatchObject({ x: "lamp_oil", ticker: "LAMPO", chain: "base" });
  });

  it("checks contract format per chain", () => {
    const sol = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    expect(validateCard({ ...base, ticker: "G", chain: "solana", contract: sol }).ok).toBe(true);
    expect(validateCard({ ...base, ticker: "G", chain: "base", contract: sol }).ok).toBe(false);
    expect(validateCard({ ...base, ticker: "G", chain: "solana", contract: "0x12" }).ok).toBe(
      false,
    );
  });

  it("requires all token fields together", () => {
    const r = validateCard({ ...base, ticker: "LAMPO" });
    expect(r.ok).toBe(false);
  });

  it("rejects bad input", () => {
    const bad = [
      { ...base, name: "" },
      { ...base, name: "x".repeat(33) },
      { ...base, description: "y".repeat(121) },
      { ...base, link: "http://example.com" },
      { ...base, link: "javascript:alert(1)" },
      { ...base, x: "not a handle!" },
      { ...base, name: "tab\there" },
      null,
    ];
    for (const b of bad) expect(validateCard(b).ok).toBe(false);
  });
});
