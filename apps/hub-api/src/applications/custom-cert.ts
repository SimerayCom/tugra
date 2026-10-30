import { X509Certificate, createPrivateKey } from "node:crypto";

/**
 * Validate + inspect an operator-uploaded custom TLS certificate (certType "custom"). PURE: no DB, no
 * Docker, no network. The private key is matched against the leaf certificate here so a mismatched pair is
 * rejected BEFORE anything is stored or written to the proxy (a bad pair would break HTTPS for the app).
 * Only the parsed domains + expiry are returned for display; the PEM bytes are stored by the caller
 * (cert is public, the key is encrypted).
 */

// A PEM cert chain + key are small; cap the input so a pathological paste can't balloon the row or the
// deploy script. 64 KiB comfortably fits a leaf + a full intermediate chain.
const MAX_PEM = 64 * 1024;

export interface CustomCertInfo {
  domains: string[]; // lowercased CN + DNS SANs (deduped) — what this cert is valid for
  notAfter: Date; // expiry, for display + an "expiring soon" hint
}

/** Does a cert that is valid for `domains` cover `host`? Exact match, or a one-level wildcard
 *  (`*.example.com` covers `a.example.com` but NOT `example.com` or `a.b.example.com`), per RFC 6125. */
export function certCoversHost(domains: string[], host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  return domains.some((d) => {
    if (d === h) return true;
    if (d.startsWith("*.")) {
      const suffix = d.slice(1); // ".example.com"
      // one label to the left of the wildcard suffix, and not an empty label
      return h.endsWith(suffix) && h.slice(0, h.length - suffix.length).length > 0 && !h.slice(0, h.length - suffix.length).includes(".");
    }
    return false;
  });
}

/** Pull the DNS names a cert is valid for: its SAN DNS entries plus the subject CN as a fallback. */
function extractDomains(x509: X509Certificate): string[] {
  const out = new Set<string>();
  // Node renders subjectAltName as e.g. `DNS:example.com, DNS:*.example.com, IP Address:1.2.3.4`.
  const san = x509.subjectAltName;
  if (san) {
    for (const part of san.split(",")) {
      const m = /^\s*DNS:(.+)$/.exec(part);
      if (m) {
        const d = m[1].trim().toLowerCase();
        if (d) out.add(d);
      }
    }
  }
  const cn = /CN=([^,/\n]+)/.exec(x509.subject ?? "");
  if (cn) {
    const d = cn[1].trim().toLowerCase();
    if (d) out.add(d);
  }
  return [...out];
}

/**
 * Parse + validate a cert/key pair. Throws an Error with a user-facing message on any problem (the caller
 * maps it to a 400). Never logs or returns the key material.
 */
export function parseCustomCert(certPem: unknown, keyPem: unknown): CustomCertInfo {
  if (typeof certPem !== "string" || typeof keyPem !== "string" || !certPem.trim() || !keyPem.trim()) {
    throw new Error("a certificate and private key are both required");
  }
  if (certPem.length > MAX_PEM || keyPem.length > MAX_PEM) {
    throw new Error("the certificate or key is too large");
  }
  if (!/-----BEGIN CERTIFICATE-----/.test(certPem)) {
    throw new Error("the certificate must be PEM (expected a -----BEGIN CERTIFICATE----- block)");
  }
  if (!/-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(keyPem)) {
    throw new Error("the private key must be PEM (expected a -----BEGIN PRIVATE KEY----- block)");
  }

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(certPem);
  } catch {
    throw new Error("the certificate could not be parsed");
  }

  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new Error("the private key could not be parsed");
  }

  // The real integrity gate: the key must belong to the leaf cert, else Traefik would serve a broken pair.
  if (!x509.checkPrivateKey(key)) {
    throw new Error("the private key does not match the certificate");
  }

  const notAfter = new Date(x509.validTo);
  const notBefore = new Date(x509.validFrom);
  if (Number.isNaN(notAfter.getTime()) || Number.isNaN(notBefore.getTime())) {
    throw new Error("the certificate has no readable validity dates");
  }
  const now = Date.now();
  if (notAfter.getTime() <= now) {
    throw new Error("the certificate has expired");
  }
  if (notBefore.getTime() > now) {
    throw new Error("the certificate is not valid yet (its start date is in the future)");
  }

  const domains = extractDomains(x509);
  if (domains.length === 0) {
    throw new Error("the certificate names no domain (no CN or SAN)");
  }

  return { domains, notAfter };
}
