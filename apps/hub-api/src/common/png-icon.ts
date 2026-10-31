import { BadRequestException } from "@nestjs/common";

/** Max stored icon size. A custom entity icon (app/project/team/database) is a small square PNG; the cap
 *  keeps the bytes out of the hot row's blast radius and bounds a direct-API upload. */
export const ICON_MAX_BYTES = 64 * 1024;

/**
 * Validate a square PNG icon by its structure (no image library): the 8-byte signature, a canonical 13-byte
 * IHDR as the first chunk, a square 32–512px dimension, and the canonical 12-byte IEND trailer. This rejects
 * a non-PNG, a wrong-ratio or out-of-range image, and a header-only/truncated/garbage-tailed upload that no
 * browser could decode — without a full decode. Throws BadRequestException on any violation. Shared by every
 * entity's icon upload (app/project/team/database) so the bar is identical everywhere.
 */
export function validatePngIcon(buf: Buffer, maxBytes: number = ICON_MAX_BYTES): void {
  if (buf.length > maxBytes) throw new BadRequestException(`icon too large (max ${Math.floor(maxBytes / 1024)}KB)`);
  // Need at least the 8-byte signature + 25-byte IHDR + 12-byte IEND to be a structurally complete PNG.
  if (buf.length < 45) throw new BadRequestException("icon is not a valid PNG");
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) throw new BadRequestException("icon must be a PNG");
  // The first chunk must be IHDR with the canonical 13-byte body (length at 8-11, type "IHDR" at 12-15).
  if (buf.readUInt32BE(8) !== 13 || buf.toString("ascii", 12, 16) !== "IHDR") {
    throw new BadRequestException("icon is not a valid PNG");
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== height) throw new BadRequestException("icon must be square");
  if (width < 32 || width > 512) throw new BadRequestException("icon must be 32-512px square");
  // Must end with the canonical 12-byte IEND chunk (empty data → fixed CRC 0xAE426082).
  const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  if (!buf.subarray(buf.length - 12).equals(IEND)) throw new BadRequestException("icon is not a valid PNG");
}
