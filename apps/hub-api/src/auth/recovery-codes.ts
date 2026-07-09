import { randomInt } from "node:crypto";

// Unambiguous alphabet (no I/L/O/0/1) so codes are easy to read/type off paper.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars
const GROUP = 4; // XXXX-XXXX

/** Generate `n` one-time recovery codes in the display form `XXXX-XXXX`. */
export function generateRecoveryCodes(n = 10): string[] {
  const codes = new Set<string>();
  while (codes.size < n) {
    let raw = "";
    for (let i = 0; i < GROUP * 2; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
    codes.add(`${raw.slice(0, GROUP)}-${raw.slice(GROUP)}`);
  }
  return [...codes];
}

/** Normalise a user-entered code: strip anything not in the alphabet, upper-case. This
 *  tolerates the dash, spaces, and lower-case so `ab23 cd45` matches `AB23-CD45`. */
export function canonicalRecoveryCode(input: string): string {
  return input.toUpperCase().replace(new RegExp(`[^${ALPHABET}]`, "g"), "");
}

/** The keyed-MAC input for a code: domain-separated + user-scoped so identical code strings
 *  don't collide across users. The actual keyed hashing is done by CryptoService.hmac(). */
export function recoveryHashInput(userId: string, input: string): string {
  return `recovery:${userId}:${canonicalRecoveryCode(input)}`;
}
