import { connect } from "node:tls";

/** "none" = the domain is not meant to serve TLS (http-only), so there is no certificate to judge. */
export type SslState = "ok" | "expiring" | "error" | "none";

export interface SslStatus {
  state: SslState;
  daysRemaining: number | null;
  validTo: string | null;
  issuer: string | null;
}

/** Classify a certificate by days remaining (≤14 → expiring soon). */
export function sslState(daysRemaining: number): "ok" | "expiring" {
  return daysRemaining > 14 ? "ok" : "expiring";
}

/**
 * Probe a public domain's TLS certificate from the hub (outbound, best-effort).
 * Returns expiry/issuer info, or {state:"error"} on any failure/timeout.
 */
export function probeSsl(host: string, timeoutMs = 4000): Promise<SslStatus> {
  return new Promise<SslStatus>((resolve) => {
    const fail = (): void => resolve({ state: "error", daysRemaining: null, validTo: null, issuer: null });
    let settled = false;
    const done = (s: SslStatus): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(s);
    };
    const socket = connect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return done({ state: "error", daysRemaining: null, validTo: null, issuer: null });
      const validTo = new Date(cert.valid_to);
      const days = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
      const one = (v: string | string[] | undefined): string | null =>
        Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      done({
        state: sslState(days),
        daysRemaining: days,
        validTo: validTo.toISOString(),
        issuer: cert.issuer ? one(cert.issuer.O) ?? one(cert.issuer.CN) : null,
      });
    });
    socket.once("timeout", () => done({ state: "error", daysRemaining: null, validTo: null, issuer: null }));
    socket.once("error", () => {
      if (!settled) {
        settled = true;
        fail();
      }
    });
  });
}

/**
 * The SSL status a dashboard should show for an app domain. A domain that is deliberately served over plain
 * http (https=false: sslip magic domain without HTTPS, TLS off) has no certificate by design, so it is "none"
 * (never probed, never an error); a domain that is meant to be https is probed and a missing cert is "error".
 */
export function domainSsl(host: string, https: boolean, probe: (h: string) => Promise<SslStatus> = probeSsl): Promise<SslStatus> {
  if (!https) return Promise.resolve({ state: "none", daysRemaining: null, validTo: null, issuer: null });
  return probe(host);
}
