import { BadRequestException } from "@nestjs/common";
import { assertSafeBase, buildMigrationCommand, buildMigrationCommandTemplate } from "./migration-command";
import { generateMigrationToken } from "./migration-token";

const TOK = generateMigrationToken();

describe("migration-command", () => {
  it("builds the one-line bootstrap mirroring the agent installer (flags after `sh -s --`)", () => {
    expect(buildMigrationCommand(TOK, "https://hub.example.com")).toBe(
      `curl -fsSL https://hub.example.com/install/migrator.sh | sh -s -- --hub https://hub.example.com --token ${TOK}`,
    );
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

  it("templates with a literal <TOKEN> and never a real token", () => {
    const tpl = buildMigrationCommandTemplate("https://hub.example.com");
    expect(tpl).toContain("--token <TOKEN>");
    expect(tpl).not.toContain("tugra_mig_");
  });
});
