import { validatePngIcon, ICON_MAX_BYTES } from "./png-icon";

const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
// Minimal structurally-valid PNG: 8-byte signature + canonical IHDR (w,h) + optional pad + canonical IEND.
function png(w: number, h: number, pad = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr, Buffer.alloc(pad), IEND]);
}

describe("validatePngIcon", () => {
  it("accepts a square 32-512px PNG", () => {
    expect(() => validatePngIcon(png(128, 128))).not.toThrow();
    expect(() => validatePngIcon(png(32, 32))).not.toThrow();
    expect(() => validatePngIcon(png(512, 512))).not.toThrow();
  });

  it("rejects a non-PNG signature", () => {
    const bad = Buffer.concat([Buffer.from("NOTAPNG!"), png(128, 128).subarray(8)]);
    expect(() => validatePngIcon(bad)).toThrow(/PNG/);
  });

  it("rejects a non-square image", () => {
    expect(() => validatePngIcon(png(128, 64))).toThrow(/square/);
  });

  it("rejects out-of-range dimensions", () => {
    expect(() => validatePngIcon(png(16, 16))).toThrow(/32-512/);
    expect(() => validatePngIcon(png(1024, 1024))).toThrow(/32-512/);
  });

  it("rejects a missing/garbled IEND trailer (truncated/garbage-tailed upload)", () => {
    const noEnd = png(128, 128).subarray(0, 40); // header only, no IEND
    expect(() => validatePngIcon(noEnd)).toThrow(/valid PNG/);
    const badTail = Buffer.concat([png(128, 128).subarray(0, 33), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])]);
    expect(() => validatePngIcon(badTail)).toThrow(/valid PNG/);
  });

  it("rejects an oversize icon", () => {
    expect(() => validatePngIcon(png(128, 128, ICON_MAX_BYTES + 100))).toThrow(/too large/);
  });

  it("honors a custom max-bytes cap", () => {
    expect(() => validatePngIcon(png(128, 128, 2000), 1024)).toThrow(/too large/);
  });
});
