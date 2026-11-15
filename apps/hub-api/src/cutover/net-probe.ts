import { Injectable } from "@nestjs/common";
import * as tls from "node:tls";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { isPublicIp, isAlwaysBlockedIp } from "../common/observed-ip";

/** Result of an SNI handshake against a specific IP (no DNS involved). */
export interface SniProbe {
  ok: boolean;
  reason?: "connect" | "timeout" | "default-cert" | "untrusted" | "wrong-host" | "expired" | "tls-error";
  issuer: string | null;
  subjectCN: string | null;
  sans: string[];
  validTo: string | null;
  daysRemaining: number | null;
}

export interface HttpProbe {
  status: number | null;
  traefik404: boolean;
  location: string | null;
  reason?: string;
}

const MAX_BODY = 4096;
const DAY = 86_400_000;

function field(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  const o = v as Record<string, unknown>;
  const x = o.CN ?? o.O;
  return typeof x === "string" ? x : Array.isArray(x) ? String(x[0]) : null;
}

/**
 * TLS handshake against `ip:443` presenting `servername` as SNI, with verification OFF so we can read the
 * certificate and judge it ourselves. Read-only: it never sends an application byte. A `TRAEFIK DEFAULT CERT`
 * means the router is not loaded or the cert is not issued yet.
 */
export function probeSslAt(ip: string, servername: string, o: { port?: number; timeoutMs?: number; ca?: string } = {}): Promise<SniProbe> {
  const empty: SniProbe = { ok: false, issuer: null, subjectCN: null, sans: [], validTo: null, daysRemaining: null };
  return new Promise((resolve) => {
    let settled = false;
    const done = (p: SniProbe) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* already closed */
      }
      resolve(p);
    };
    const sock = tls.connect({ host: ip, port: o.port ?? 443, servername, rejectUnauthorized: false, timeout: o.timeoutMs ?? 6000, ...(o.ca ? { ca: o.ca } : {}) });
    sock.once("secureConnect", () => {
      const c = sock.getPeerCertificate();
      if (!c || !c.subject) return done({ ...empty, reason: "tls-error" });
      const subjectCN = field(c.subject);
      const issuer = field(c.issuer);
      const sans = String(c.subjectaltname ?? "").split(",").map((s) => s.trim().replace(/^DNS:/, "")).filter(Boolean);
      const validToMs = Date.parse(c.valid_to);
      const daysRemaining = Number.isFinite(validToMs) ? Math.floor((validToMs - Date.now()) / DAY) : null;
      const base = { issuer, subjectCN, sans, validTo: Number.isFinite(validToMs) ? new Date(validToMs).toISOString() : null, daysRemaining };
      if (subjectCN === "TRAEFIK DEFAULT CERT") return done({ ...base, ok: false, reason: "default-cert" });
      if (daysRemaining !== null && validToMs < Date.now()) return done({ ...base, ok: false, reason: "expired" });
      if (tls.checkServerIdentity(servername, c)) return done({ ...base, ok: false, reason: "wrong-host" });
      if (!sock.authorized) return done({ ...base, ok: false, reason: "untrusted" });
      return done({ ...base, ok: true });
    });
    sock.once("timeout", () => done({ ...empty, reason: "timeout" }));
    sock.once("error", (e: NodeJS.ErrnoException) => {
      const code = e.code ?? "";
      done({ ...empty, reason: code === "ETIMEDOUT" ? "timeout" : /^(ECONN|EHOST|ENET|EAI)/.test(code) ? "connect" : "tls-error" });
    });
  });
}

/**
 * One HTTP(S) request straight at `ip` with a Host header (and SNI for https). No redirect following, at most
 * 4 KiB of body read before the socket is aborted. `traefik404` is true for Traefik's own "no router matched" body.
 */
export function probeHttpAt(ip: string, host: string, o: { tls: boolean; path?: string; timeoutMs?: number; port?: number }): Promise<HttpProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (p: HttpProbe) => {
      if (settled) return;
      settled = true;
      resolve(p);
    };
    const opts: https.RequestOptions = {
      host: ip,
      port: o.port ?? (o.tls ? 443 : 80),
      path: o.path ?? "/",
      method: "GET",
      headers: { Host: host, "User-Agent": "tugra-cutover-probe", Accept: "*/*", Connection: "close" },
      timeout: o.timeoutMs ?? 8000,
      ...(o.tls ? { servername: host, rejectUnauthorized: false } : {}),
    };
    const req = (o.tls ? https : http).request(opts, (res) => {
      let body = "";
      let bytes = 0;
      res.setEncoding("utf8");
      const status = res.statusCode ?? null;
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      res.on("data", (chunk: string) => {
        bytes += chunk.length;
        if (body.length < MAX_BODY) body += chunk;
        if (bytes >= MAX_BODY) {
          res.destroy();
          finish({ status, traefik404: status === 404 && body.startsWith("404 page not found"), location });
        }
      });
      res.on("end", () => finish({ status, traefik404: status === 404 && body.startsWith("404 page not found"), location }));
      res.on("error", () => finish({ status, traefik404: status === 404 && body.startsWith("404 page not found"), location }));
      res.on("close", () => finish({ status, traefik404: status === 404 && body.startsWith("404 page not found"), location }));
    });
    req.on("timeout", () => {
      req.destroy();
      finish({ status: null, traefik404: false, location: null, reason: "timeout" });
    });
    req.on("error", (e: NodeJS.ErrnoException) => finish({ status: null, traefik404: false, location: null, reason: e.code ?? "error" }));
    req.end();
  });
}

/** The IP a probe may connect to: a DB-sourced public address, never a request input, never an internal one. */
export function assertProbeIp(ip: string): void {
  if (isIP(ip) === 0 || !isPublicIp(ip) || isAlwaysBlockedIp(ip)) throw new Error("refusing to probe a non-public address");
}

/** Injectable wrapper so the service can be tested with a fake. Every call re-asserts the IP is public. */
@Injectable()
export class NetProbe {
  sslAt(ip: string, servername: string): Promise<SniProbe> {
    assertProbeIp(ip);
    return probeSslAt(ip, servername);
  }
  httpAt(ip: string, host: string, o: { tls: boolean; path?: string }): Promise<HttpProbe> {
    assertProbeIp(ip);
    return probeHttpAt(ip, host, o);
  }
}
