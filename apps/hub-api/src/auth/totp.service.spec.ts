import { authenticator } from "otplib";
import { TotpService } from "./totp.service";

describe("TotpService", () => {
  const svc = new TotpService();

  it("verifies a valid current token", () => {
    const secret = svc.generateSecret();
    const token = authenticator.generate(secret);
    expect(svc.verify(token, secret)).toBe(true);
  });

  it("rejects a wrong token", () => {
    const secret = svc.generateSecret();
    expect(svc.verify("000000", secret)).toBe(false);
  });

  it("builds an otpauth key uri with the issuer", () => {
    const uri = svc.keyUri("user@example.com", svc.generateSecret());
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("Tugra");
  });
});
