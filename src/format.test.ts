import { describe, expect, it } from "vitest";
import { boxLabel, dexscreenerUrl, formatDuration, initials, shortAddress } from "./format";

describe("format", () => {
  it("shortens addresses", () => {
    expect(shortAddress("0x7a3f9c21d04e5b8a6f1e2d3c4b5a69788f1e2d3c")).toBe("0x7a3f…2d3c");
    expect(shortAddress("short")).toBe("short");
  });

  it("builds DexScreener links", () => {
    expect(dexscreenerUrl("solana", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBe(
      "https://dexscreener.com/solana/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    );
  });

  it("labels tokens by ticker and brands by name", () => {
    expect(boxLabel({ name: "Lamp Oil", ticker: "LAMPO" })).toBe("$LAMPO");
    expect(boxLabel({ name: "Chalk Dust Studio" })).toBe("Chalk Dust Studio");
  });

  it("makes initials", () => {
    expect(initials("Chalk Dust Studio")).toBe("CD");
    expect(initials("Grainfield")).toBe("GR");
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(1834)).toBe("30m 34s");
  });
});
