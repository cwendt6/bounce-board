/**
 * Buyer logos. The page sends a data URL (it re-encodes uploads to a 256x256 WebP first).
 * The server trusts nothing from the page: it checks the declared type against the file's
 * magic bytes and enforces the size cap. SVG is never accepted, because SVGs can carry scripts.
 */
export const MAX_LOGO_BYTES = 500 * 1024;

export type LogoMime = "image/png" | "image/jpeg" | "image/webp";

export interface Logo {
  mime: LogoMime;
  bytes: Uint8Array;
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
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  } catch {
    return { ok: false, error: "logo: unreadable image data" };
  }
  if (bytes.length > MAX_LOGO_BYTES) return { ok: false, error: "logo: at most 500 KB" };
  const actual = sniff(bytes);
  if (!actual || actual !== m[1])
    return { ok: false, error: "logo: file is not the image type it claims" };
  return { ok: true, logo: { mime: actual, bytes } };
}
