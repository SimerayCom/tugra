import { BadRequestException } from "@nestjs/common";
import { assertSafeBase, buildMigrationCommand, buildMigrationCommandTemplate } from "./migration-command";
import { generateMigrationToken } from "./migration-token";

const TOK = generateMigrationToken();

describe("migration-command", () => {
  it("builds the one-line bootstrap with the token in the sh ENVIRONMENT, never on an argv", () => {
    const cmd = buildMigrationCommand(TOK, "https://hub.example.com");
    expect(cmd).toBe(
      `curl -fsSL https://hub.example.com/install/migrator.sh | TUGRA_MIGRATION_TOKEN=${TOK} sh -s -- --hub https://hub.example.com`,
    );
    // the token must NOT appear as a --token flag value (the whole point of the env-form)
    expect(cmd).not.toContain("--token");
    expect(cmd).toMatch(/\| TUGRA_MIGRATION_TOKEN=tugra_mig_[A-Za-z0-9_-]{43} sh -s -- --hub /);
  });

  it("rejects a non-migration token (never embeds a PAT/garbage)", () => {
    expect(() => buildMigrationCommand("tugra_pat_" + "a".repeat(43), "https://hub.example.com")).toThrow(BadRequestException);
  });

  it("rejects a hub base URL carrying shell metacharacters (Host-header injection into the command)", () => {
    for (const evil of [
      "http://evil.test;rm -rf /",
      "http://evil.test rm",
      "http://evil.test/`id`",
      "http://evil.test/$(id)",
      "http://evil.test/a\nb",
      "ftp://hub.example.com",
      "hub.example.com", // no scheme
      'http://evil"test',
    ]) {
      expect(() => assertSafeBase(evil)).toThrow(BadRequestException);
      expect(() => buildMigrationCommand(TOK, evil)).toThrow(BadRequestException);
    }
  });

  it("accepts a plain origin, an origin:port, and a safe path prefix", () => {
    for (const ok of ["http://localhost:3000", "https://hub.example.com", "https://hub.example.com:8443/tugra"]) {
      expect(() => assertSafeBase(ok)).not.toThrow();
    }
  });

  it("templates with a literal <TOKEN> in the env slot and never a real token", () => {
    const tpl = buildMigrationCommandTemplate("https://hub.example.com");
    expect(tpl).toContain("TUGRA_MIGRATION_TOKEN=<TOKEN>");
    expect(tpl).not.toContain("--token");
    expect(tpl).not.toContain("tugra_mig_");
  });
});
