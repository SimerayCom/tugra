import { createHash } from "node:crypto";
import {
  generateMigrationToken,
  hashMigrationToken,
  isMigrationToken,
  MIGRATION_TOKEN_PREFIX,
  MIGRATION_TOKEN_RE,
  MIGRATION_TOKEN_TTL_MS,
} from "./migration-token";

describe("migration-token (pure)", () => {
  it("generates a tugra_mig_ token of 256-bit base64url entropy", () => {
    const t = generateMigrationToken();
    expect(t.startsWith(MIGRATION_TOKEN_PREFIX)).toBe(true);
    expect(t).toMatch(MIGRATION_TOKEN_RE);
    expect(t.length).toBe(MIGRATION_TOKEN_PREFIX.length + 43); // 10 + 43 = 53
  });

  it("mints unique tokens (no collisions over 1000)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateMigrationToken());
    expect(seen.size).toBe(1000);
  });

  it("accepts only well-formed tokens and rejects everything else (guard pre-filter)", () => {
    expect(isMigrationToken(generateMigrationToken())).toBe(true);
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "tugra_mig_",
      "tugra_pat_" + "a".repeat(43), // wrong family (a PAT)
      "tugra_mig_" + "a".repeat(42), // too short
      "tugra_mig_" + "a".repeat(44), // too long
      "tugra_mig_" + "a".repeat(42) + ";", // shell metachar
      "tugra_mig_" + "a".repeat(40) + " $( ", // space + command substitution
      "tugra_mig_" + "a".repeat(42) + "/", // '/' not in base64url
    ] as unknown[]) {
      expect(isMigrationToken(bad)).toBe(false);
    }
  });

  it("hashes with SHA-256 hex, deterministically (only the hash is stored)", () => {
    const t = generateMigrationToken();
    const expected = createHash("sha256").update(t).digest("hex");
    expect(hashMigrationToken(t)).toBe(expected);
    expect(hashMigrationToken(t)).toBe(hashMigrationToken(t));
    expect(hashMigrationToken(t)).not.toBe(t);
  });

  it("uses a 1-hour TTL", () => {
    expect(MIGRATION_TOKEN_TTL_MS).toBe(60 * 60 * 1000);
  });
});
