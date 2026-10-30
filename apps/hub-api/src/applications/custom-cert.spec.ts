import { parseCustomCert, certCoversHost } from "./custom-cert";

// Self-signed EC fixtures (CN=tugra-test.example, SAN DNS:tugra-test.example + *.tugra-test.example).
// CERT + KEY1 are a matching pair; KEY2 is an unrelated EC key (traditional "EC PRIVATE KEY" PEM).
const CERT = `-----BEGIN CERTIFICATE-----
MIIBxjCCAWygAwIBAgIUaLI0PRf5bR1q5Y5k5MQ1SxO8pX0wCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSdHVncmEtdGVzdC5leGFtcGxlMB4XDTI2MTAzMDAzNDAyOVoX
DTM2MTAyNzAzNDAyOVowHTEbMBkGA1UEAwwSdHVncmEtdGVzdC5leGFtcGxlMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUeZ6jlqJeBv/eQPD0RhOqk2prmMUVj9k
JVj3aCSwbI3E02jpCDzF6k20BEHOSqJIFKiVp1Bf94YZfnapzWVH8KOBiTCBhjAd
BgNVHQ4EFgQU9qwu8GCvflBDl33acHM4u/FsW9gwHwYDVR0jBBgwFoAU9qwu8GCv
flBDl33acHM4u/FsW9gwDwYDVR0TAQH/BAUwAwEB/zAzBgNVHREELDAqghJ0dWdy
YS10ZXN0LmV4YW1wbGWCFCoudHVncmEtdGVzdC5leGFtcGxlMAoGCCqGSM49BAMC
A0gAMEUCIQC7CHAqLnLzawmQ5we1reLn2uARMc64pSZbC4UAHHZAKQIgdeYGgxzW
eXKNPjkBbbIYBhSDvWxdsJoMhXQbCvtwpsE=
-----END CERTIFICATE-----`;

const KEY1 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgP9U2qJmoTq/A/9r7
l56Hlo/EDDhnIBNJ8NVVzDpmIJ2hRANCAARR5nqOWol4G/95A8PRGE6qTamuYxRW
P2QlWPdoJLBsjcTTaOkIPMXqTbQEQc5KokgUqJWnUF/3hhl+dqnNZUfw
-----END PRIVATE KEY-----`;

const KEY2 = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIP8EAFssOhhdlEeBgWMm9NPBvWNaB1keQ51NPKTQookLoAoGCCqGSM49
AwEHoUQDQgAEs6te5P3+lAAezKMD63gPagBzRrI8Rj0zjuk7SdNd+HzmhsTEsSFH
vN8ImehNPGyqIccy2d/bD7RRfI1xgx5gTg==
-----END EC PRIVATE KEY-----`;

describe("parseCustomCert", () => {
  it("accepts a matching cert/key pair and extracts domains + expiry", () => {
    const info = parseCustomCert(CERT, KEY1);
    expect(info.domains).toEqual(expect.arrayContaining(["tugra-test.example", "*.tugra-test.example"]));
    expect(info.notAfter.getTime()).toBeGreaterThan(Date.parse("2030-01-01"));
  });

  it("rejects a key that does not match the certificate", () => {
    expect(() => parseCustomCert(CERT, KEY2)).toThrow(/does not match/i);
  });

  it("rejects a non-PEM certificate", () => {
    expect(() => parseCustomCert("not a cert", KEY1)).toThrow(/certificate must be PEM/i);
  });

  it("rejects a non-PEM private key", () => {
    expect(() => parseCustomCert(CERT, "not a key")).toThrow(/key must be PEM/i);
  });

  it("rejects a malformed certificate body", () => {
    const broken = "-----BEGIN CERTIFICATE-----\nnotbase64!!!\n-----END CERTIFICATE-----";
    expect(() => parseCustomCert(broken, KEY1)).toThrow(/could not be parsed/i);
  });

  it("rejects empty input", () => {
    expect(() => parseCustomCert("", "")).toThrow(/required/i);
    expect(() => parseCustomCert(CERT, "")).toThrow(/required/i);
  });

  it("rejects oversized input", () => {
    const huge = CERT + "\n" + "A".repeat(70 * 1024);
    expect(() => parseCustomCert(huge, KEY1)).toThrow(/too large/i);
  });
});

describe("certCoversHost", () => {
  it("matches an exact SAN", () => {
    expect(certCoversHost(["shop.example.com"], "shop.example.com")).toBe(true);
    expect(certCoversHost(["shop.example.com"], "other.example.com")).toBe(false);
  });

  it("matches a one-level wildcard but not the apex or a deeper label", () => {
    expect(certCoversHost(["*.example.com"], "a.example.com")).toBe(true);
    expect(certCoversHost(["*.example.com"], "example.com")).toBe(false);
    expect(certCoversHost(["*.example.com"], "a.b.example.com")).toBe(false);
  });

  it("is case-insensitive and ignores surrounding whitespace in the host", () => {
    expect(certCoversHost(["shop.example.com"], "  SHOP.Example.com ")).toBe(true);
  });

  it("returns false for an empty host or empty domain list", () => {
    expect(certCoversHost(["shop.example.com"], "")).toBe(false);
    expect(certCoversHost([], "shop.example.com")).toBe(false);
  });
});
