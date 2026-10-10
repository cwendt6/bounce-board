import { describe, expect, it } from "vitest";
import images from "./fixtures/canvas-images.json";
import { dimensions, MAX_LOGO_BYTES, parseLogo, sniff } from "./logo";

const b64 = (bytes: ArrayLike<number>) => Buffer.from(Uint8Array.from(bytes)).toString("base64");
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Simple lossy WebP ("VP8 ") header with the given size (little-endian 14-bit fields). */
function vp8(w: number, h: number): number[] {
  return [
    ...ascii("RIFF"),
    30,
    0,
    0,
    0,
    ...ascii("WEBP"),
    ...ascii("VP8 "),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    w & 0xff,
    (w >> 8) & 0x3f,
    h & 0xff,
    (h >> 8) & 0x3f,
  ];
}

/** Lossless WebP ("VP8L") header: 14-bit width-1 and height-1 packed after the 0x2f byte. */
function vp8l(w: number, h: number): number[] {
  const bits = (w - 1) | ((h - 1) << 14);
  return [
    ...ascii("RIFF"),
    30,
    0,
    0,
    0,
    ...ascii("WEBP"),
    ...ascii("VP8L"),
    10,
    0,
    0,
    0,
    0x2f,
    bits & 0xff,
    (bits >> 8) & 0xff,
    (bits >> 16) & 0xff,
    (bits >> 24) & 0xff,
  ];
}

describe("logos", () => {
  it("sniffs PNG, JPEG and WebP by magic bytes", () => {
    for (const [k, mime] of [
      ["png_256", "image/png"],
      ["jpeg_300x200", "image/jpeg"],
      ["webp_256", "image/webp"],
    ] as const) {
      const bytes = Buffer.from((images[k] as string).split(",")[1], "base64");
      expect(sniff(new Uint8Array(bytes))).toBe(mime);
    }
    expect(sniff(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });

  it("treats a missing logo as none", () => {
    expect(parseLogo(undefined)).toEqual({ ok: true, logo: null });
    expect(parseLogo("")).toEqual({ ok: true, logo: null });
  });

  it("accepts real browser images and reads their pixel size", () => {
    const cases: [keyof typeof images, string, number, number][] = [
      ["png_256", "image/png", 256, 256],
      ["jpeg_300x200", "image/jpeg", 300, 200],
      ["webp_256", "image/webp", 256, 256],
      ["webp_alpha_256", "image/webp", 256, 256],
      ["webp_lossless_300x200", "image/webp", 300, 200],
    ];
    for (const [key, mime, w, h] of cases) {
      const r = parseLogo(images[key]);
      expect(r.ok, key).toBe(true);
      if (r.ok) expect([r.logo?.mime, r.logo?.width, r.logo?.height], key).toEqual([mime, w, h]);
    }
  });

  it("reads simple VP8 and VP8L WebP headers too", () => {
    expect(dimensions(Uint8Array.from(vp8(256, 200)), "image/webp")).toEqual({
      width: 256,
      height: 200,
    });
    expect(dimensions(Uint8Array.from(vp8l(300, 123)), "image/webp")).toEqual({
      width: 300,
      height: 123,
    });
  });

  it("refuses images larger than 512x512 pixels", () => {
    const r = parseLogo(images.png_1024x768);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/512x512/);
    expect(parseLogo(`data:image/webp;base64,${b64(vp8l(4096, 4096))}`).ok).toBe(false);
  });

  it("refuses an image whose size can't be read", () => {
    const truncated = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    expect(parseLogo(`data:image/png;base64,${b64(truncated)}`).ok).toBe(false);
  });

  it("rejects SVG, mismatched types and junk", () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64");
    const jpeg = (images.jpeg_300x200 as string).split(",")[1];
    expect(parseLogo(`data:image/svg+xml;base64,${svg}`).ok).toBe(false);
    expect(parseLogo(`data:image/png;base64,${jpeg}`).ok).toBe(false);
    expect(parseLogo(`data:image/png;base64,${svg}`).ok).toBe(false);
    expect(parseLogo("https://example.com/logo.png").ok).toBe(false);
    expect(parseLogo(42).ok).toBe(false);
  });

  it("enforces the 500 KB cap", () => {
    const big = new Uint8Array(MAX_LOGO_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(parseLogo(`data:image/png;base64,${Buffer.from(big).toString("base64")}`).ok).toBe(
      false,
    );
  });
});
