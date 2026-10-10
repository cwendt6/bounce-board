/**
 * Buyer logos. The page sends a data URL (it re-encodes uploads to a 256x256 WebP first).
 * The server trusts nothing from the page: it checks the declared type against the file's
 * magic bytes and enforces the size cap. SVG is never accepted, because SVGs can carry scripts.
 */
export const MAX_LOGO_BYTES = 500 * 1024;
/** The page sends 256x256; anything above this is refused (huge canvases can crash viewers). */
export const MAX_LOGO_SIDE = 512;

export type LogoMime = "image/png" | "image/jpeg" | "image/webp";

export interface Logo {
  mime: LogoMime;
  bytes: Uint8Array;
  width: number;
  height: number;
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  return sig.every((v, i) => b[offset + i] === v);
}

export function sniff(b: Uint8Array): LogoMime | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // RIFF....WEBP
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** Pixel size from the file header (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X), or null. */
export function dimensions(
  b: Uint8Array,
  mime: LogoMime,
): { width: number; height: number } | null {
  if (mime === "image/png") {
    if (b.length < 24 || String.fromCharCode(...b.subarray(12, 16)) !== "IHDR") return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = u16be(b, i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP then one of VP8X / VP8L / "VP8 ".
  const chunk = String.fromCharCode(...b.subarray(12, 16));
  if (chunk === "VP8X" && b.length >= 30) {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    // Lossy VP8: 14-bit little-endian width and height right after the start code.
    return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  return null;
}

export type LogoResult = { ok: true; logo: Logo | null } | { ok: false; error: string };

/** Absent or empty means no logo. Anything else must be a valid PNG, JPEG or WebP data URL. */
export function parseLogo(input: unknown): LogoResult {
  if (input === undefined || input === null || input === "") return { ok: true, logo: null };
  if (typeof input !== "string") return { ok: false, error: "logo: expected a data URL" };
  // Base64 is 4/3 of the raw size; reject oversize input before decoding it.
  if (input.length > Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 64) {
    return { ok: false, error: "logo: at most 500 KB" };
  }
  const m = DATA_URL.exec(input);
  if (!m) return { ok: false, error: "logo: PNG, JPG or WebP only" };
  // Buffer's native base64 decoder (nodejs_compat) is ~100x faster than atob + a JS loop,
  // which matters under the free plan's 10 ms CPU limit per request.
  const bytes = new Uint8Array(Buffer.from(m[2], "base64"));
  if (bytes.length === 0) return { ok: false, error: "logo: unreadable image data" };
  if (bytes.length > MAX_LOGO_BYTES) return { ok: false, error: "logo: at most 500 KB" };
  const actual = sniff(bytes);
  if (!actual || actual !== m[1]) {
    return { ok: false, error: "logo: file is not the image type it claims" };
  }
  const dims = dimensions(bytes, actual);
  if (!dims || dims.width < 1 || dims.height < 1) {
    return { ok: false, error: "logo: unreadable image size" };
  }
  if (dims.width > MAX_LOGO_SIDE || dims.height > MAX_LOGO_SIDE) {
    return { ok: false, error: `logo: at most ${MAX_LOGO_SIDE}x${MAX_LOGO_SIDE} pixels` };
  }
  return { ok: true, logo: { mime: actual, bytes, ...dims } };
}
