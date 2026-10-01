import { describe, expect, it } from "vitest";
import { MAX_LOGO_BYTES, parseLogo, sniff } from "./logo";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16];
const WEBP = [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50];

describe("logos", () => {
  it("sniffs PNG, JPEG and WebP by magic bytes", () => {
    expect(sniff(Uint8Array.from(PNG))).toBe("image/png");
    expect(sniff(Uint8Array.from(JPEG))).toBe("image/jpeg");
    expect(sniff(Uint8Array.from(WEBP))).toBe("image/webp");
    expect(sniff(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });

  it("treats a missing logo as none", () => {
    expect(parseLogo(undefined)).toEqual({ ok: true, logo: null });
    expect(parseLogo("")).toEqual({ ok: true, logo: null });
  });

  it("accepts a real WebP data URL", () => {
    const r = parseLogo(`data:image/webp;base64,${b64(WEBP)}`);
    expect(r.ok && r.logo?.mime).toBe("image/webp");
  });

  it("rejects SVG, mismatched types and junk", () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64");
    expect(parseLogo(`data:image/svg+xml;base64,${svg}`).ok).toBe(false);
    expect(parseLogo(`data:image/png;base64,${b64(JPEG)}`).ok).toBe(false);
    expect(parseLogo(`data:image/png;base64,${svg}`).ok).toBe(false);
    expect(parseLogo("https://example.com/logo.png").ok).toBe(false);
    expect(parseLogo(42).ok).toBe(false);
  });

  it("enforces the 500 KB cap", () => {
    const big = new Uint8Array(MAX_LOGO_BYTES + 1);
    big.set(PNG);
    expect(parseLogo(`data:image/png;base64,${Buffer.from(big).toString("base64")}`).ok).toBe(
      false,
    );
  });
});
