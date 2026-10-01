/**
 * Prepare a buyer's logo in the browser: accept PNG, JPG or WebP up to 500 KB, center-crop
 * to a square, and re-encode to a 256x256 WebP (PNG if the browser can't encode WebP).
 * Re-encoding drops metadata and anything else riding along in the original file.
 * The server re-checks type and size; this is for a fast, friendly error.
 */
export const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];
export const MAX_BYTES = 500 * 1024;
const SIZE = 256;

export class LogoError extends Error {}

export async function prepareLogo(file: File): Promise<string> {
  if (!ACCEPTED.includes(file.type)) throw new LogoError("Logo must be PNG, JPG or WebP.");
  if (file.size > MAX_BYTES) throw new LogoError("Logo must be 500 KB or smaller.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new LogoError("Couldn't read that image.");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new LogoError("Couldn't process that image.");
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();
  const webp = canvas.toDataURL("image/webp", 0.86);
  const out = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  // base64 is 4/3 of the bytes
  if ((out.length - out.indexOf(",") - 1) * 0.75 > MAX_BYTES) {
    throw new LogoError("Logo is too large after resizing.");
  }
  return out;
}
