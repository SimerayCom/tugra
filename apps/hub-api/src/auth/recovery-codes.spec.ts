import { generateRecoveryCodes, canonicalRecoveryCode, recoveryHashInput } from "./recovery-codes";

describe("recovery codes", () => {
  it("generates n unique XXXX-XXXX codes from an unambiguous alphabet", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
      expect(c).not.toMatch(/[ILO01]/); // ambiguous chars excluded
    }
  });

  it("canonical form is dash/space/case tolerant", () => {
    expect(canonicalRecoveryCode("AB23-CD45")).toBe("AB23CD45");
    expect(canonicalRecoveryCode("ab23 cd45")).toBe("AB23CD45");
    expect(canonicalRecoveryCode("  AB23CD45 ")).toBe("AB23CD45");
  });

  it("recoveryHashInput is user-scoped + domain-separated + canonical (dash/case tolerant)", () => {
    // same code, same user → same MAC input regardless of dashes/case
    expect(recoveryHashInput("u1", "AB23-CD45")).toBe(recoveryHashInput("u1", "ab23 cd45"));
    // user-scoped: identical code strings for different users don't collide
    expect(recoveryHashInput("u1", "AB23-CD45")).not.toBe(recoveryHashInput("u2", "AB23-CD45"));
    // domain-separated
    expect(recoveryHashInput("u1", "AB23-CD45")).toBe("recovery:u1:AB23CD45");
  });
});
