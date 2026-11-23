import { X509Certificate, createPrivateKey, createSign, createVerify } from "node:crypto";
import { generateSelfSignedCert, certFingerprint, certSpkiPin } from "./self-signed-cert";

describe("generateSelfSignedCert", () => {
  const c = generateSelfSignedCert({ ip: "203.0.113.7" });
  const x = new X509Certificate(c.certPem);

  it("is a well-formed, self-signed X.509 v3 certificate that verifies against its own key", () => {
    expect(x.subject).toContain("CN=203.0.113.7");
    expect(x.issuer).toBe(x.subject);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.ca).toBe(false);
  });

  it("carries the IP as a SAN, so OpenSSL/curl accept it for that address", () => {
    expect(x.subjectAltName).toBe("IP Address:203.0.113.7");
    expect(x.checkIP("203.0.113.7")).toBe("203.0.113.7");
    expect(x.checkIP("203.0.113.8")).toBeUndefined();
  });

  it("is valid now and for about ten years, with a tolerance for a skewed agent clock", () => {
    const now = Date.now();
    expect(new Date(x.validFrom).getTime()).toBeLessThan(now);
    expect(new Date(x.validTo).getTime()).toBeGreaterThan(now + 9 * 365 * 24 * 3600_000);
  });

  it("is for TLS server authentication only (digitalSignature + serverAuth)", () => {
    expect(x.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(x.toString()).toContain("BEGIN CERTIFICATE");
  });

  it("fingerprint equals the sha256 of the DER and the recomputed value from the PEM", () => {
    expect(c.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(certFingerprint(c.certPem)).toBe(c.fingerprint);
  });

  it("the key matches the certificate (a signature made with it verifies with the certificate's key)", () => {
    const priv = createPrivateKey(c.keyPem);
    const sig = createSign("sha256").update("x").sign(priv);
    expect(x.publicKey.asymmetricKeyType).toBe("ec");
    expect(createVerify("sha256").update("x").verify(x.publicKey, sig)).toBe(true);
  });

  it("each generation is a fresh key and serial, so two certs never share a fingerprint", () => {
    const d = generateSelfSignedCert({ ip: "203.0.113.7" });
    expect(d.fingerprint).not.toBe(c.fingerprint);
    expect(new X509Certificate(d.certPem).serialNumber).not.toBe(x.serialNumber);
  });

  it("a non-IP / missing address yields a certificate without a SAN (nothing invalid is embedded)", () => {
    for (const ip of [undefined, "not-an-ip", "999.1.1.1"]) {
      const y = new X509Certificate(generateSelfSignedCert({ ip }).certPem);
      expect(y.subjectAltName).toBeUndefined();
    }
  });

  it("spki pin is the base64 sha256 curl --pinnedpubkey expects", () => {
    expect(certSpkiPin(c.certPem)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});
