/**
 * HyperLogLog for unique visitors. THE CONTRACT BELOW IS IMPLEMENTED IDENTICALLY IN GO
 * (agent/internal/traffic/hll.go); both must produce byte-identical sketches for the same input list, which the
 * golden tests on each side pin (same IP list, same expected base64).
 *
 *  - precision p = 12 -> m = 4096 registers, one byte each (value 0..53 in practice, 0..63 allowed). The sketch
 *    is the 4096-byte register array; its base64 is the TrafficDomainStat.unique string.
 *  - Input is the NORMALIZED client IP string (public addresses only; the agent skips private/loopback/invalid),
 *    hashed to 64 bits in two fixed steps:
 *      (1) FNV-1a-64 over the UTF-8 bytes (offset 0xcbf29ce484222325, prime 0x100000001b3, mod 2^64);
 *      (2) splitmix64 finalizer: z ^= z>>30; z *= 0xbf58476d1ce4e5b9; z ^= z>>27; z *= 0x94d049bb133111eb;
 *          z ^= z>>31 (all mod 2^64).
 *  - index = z >> (64-p) (top p bits); rank = min(leadingZeros64(z << p), 64-p) + 1 (an all-zero suffix has rank
 *    64-p+1); register[index] = max(register[index], rank).
 *  - estimate: E = alpha_m*m*m / sum(2^-reg[j]), alpha_m = 0.7213/(1+1.079/m); if E <= 2.5*m and V (zero
 *    registers) > 0 then E = m*ln(m/V). No large-range correction (64-bit hash). Rounded to a non-negative int.
 *  - merge(a, b) = element-wise max.
 *
 * Privacy: a sketch holds only max leading-zero ranks, never an address. The hub never sees a client IP; it only
 * stores, merges and estimates register arrays. (addString exists for tests and tooling, not for the ingest path.)
 */
export const HLL_P = 12;
export const HLL_M = 1 << HLL_P; // 4096 registers == sketch length in bytes
const SUFFIX_BITS = 64 - HLL_P;
const MASK64 = (1n << 64n) - 1n;

/** The contract's two-step 64-bit hash of an IP string. */
export function hllHash(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(s, "utf8")) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & MASK64;
  }
  let z = h;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}

export function newSketch(): Uint8Array {
  return new Uint8Array(HLL_M);
}

/** Folds one (already normalized) address string into `reg` in place. */
export function addString(reg: Uint8Array, ip: string): void {
  const z = hllHash(ip);
  const idx = Number(z >> BigInt(SUFFIX_BITS));
  const suffix = (z << BigInt(HLL_P)) & MASK64;
  // leading zeros of the 64-bit value, capped at the suffix width
  const lz = suffix === 0n ? SUFFIX_BITS : Math.min(64 - suffix.toString(2).length, SUFFIX_BITS);
  const rank = lz + 1;
  if (rank > reg[idx]) reg[idx] = rank;
}

/** Element-wise max of `src` into `dst` (both HLL_M long). */
export function mergeInto(dst: Uint8Array, src: ArrayLike<number>): void {
  for (let i = 0; i < HLL_M; i++) if (src[i] > dst[i]) dst[i] = src[i];
}

/** Cardinality estimate (see the contract above): a non-negative integer. */
export function estimate(reg: ArrayLike<number>): number {
  const m = HLL_M;
  let sum = 0;
  let zeros = 0;
  for (let i = 0; i < m; i++) {
    sum += Math.pow(2, -reg[i]);
    if (reg[i] === 0) zeros++;
  }
  const alpha = 0.7213 / (1 + 1.079 / m);
  let e = (alpha * m * m) / sum;
  if (e <= 2.5 * m && zeros > 0) e = m * Math.log(m / zeros);
  return Number.isFinite(e) && e > 0 ? Math.round(e) : 0;
}

export const encodeSketch = (reg: Uint8Array): string => Buffer.from(reg.buffer, reg.byteOffset, reg.byteLength).toString("base64");

/**
 * Decodes a wire sketch. Null unless it is canonical base64 of exactly HLL_M bytes whose registers are all
 * <= 64-p+1 (a larger value is impossible from a conforming agent; accepting it would let a hostile agent skew
 * the estimate arbitrarily).
 */
export function decodeSketch(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length === 0 || b64.length > 8192) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== HLL_M) return null;
  const out = new Uint8Array(buf);
  for (let i = 0; i < HLL_M; i++) if (out[i] > SUFFIX_BITS + 1) return null;
  return out;
}
