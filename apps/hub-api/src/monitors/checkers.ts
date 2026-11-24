import net from "node:net";
import http from "node:http";
import https from "node:https";
import { execFile } from "node:child_process";
import { Resolver } from "node:dns/promises";
import type { Monitor } from "@prisma/client";
import { cloudflareCause, cloudflareSummary } from "./cloudflare";

export interface CheckResult {
  up: boolean;
  ms: number;
  msg: string;
  /** Machine-readable failure class (e.g. "cf:522"); the web app localizes it. Absent for a plain result. */
  cause?: string | null;
}

/** The decrypted httpOptionsEnc payload: request headers, basic-auth credentials and a request body. */
export interface HttpOptions {
  headers?: Record<string, string>;
  basicAuth?: { user: string; pass: string };
  body?: string;
}

export type Checker = (monitor: Monitor, opts?: HttpOptions) => Promise<CheckResult>;

const MAX_KEYWORD_BODY = 1024 * 1024; // read at most 1 MiB of the response when looking for a keyword
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Parse ["200-299","301"] into inclusive ranges; malformed entries are ignored. */
export function parseStatusRanges(list: readonly string[] | null | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const raw of list ?? []) {
    const m = /^\s*(\d{3})(?:\s*-\s*(\d{3}))?\s*$/.exec(raw);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    if (hi >= lo) out.push([lo, hi]);
  }
  return out;
}

/** Is `status` accepted? An empty/invalid list keeps the original rule: any 2xx or 3xx. */
export function statusAccepted(status: number, list: readonly string[] | null | undefined): boolean {
  const ranges = parseStatusRanges(list);
  if (ranges.length === 0) return status >= 200 && status < 400;
  return ranges.some(([lo, hi]) => status >= lo && status <= hi);
}

/** Flip a result for "upside down" monitors (UP when the target is NOT reachable). */
export function applyUpsideDown(r: CheckResult): CheckResult {
  return { up: !r.up, ms: r.ms, msg: `${r.msg} (inverted)`, cause: null };
}

interface RawResponse {
  status: number;
  location?: string;
  server?: string;
  body: string;
}

function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  readBody: boolean,
  ignoreTls: boolean,
  signal: AbortSignal,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      { method, headers, signal, ...(url.protocol === "https:" ? { rejectUnauthorized: !ignoreTls } : {}) },
      (res) => {
        const base = {
          status: res.statusCode ?? 0,
          location: typeof res.headers.location === "string" ? res.headers.location : undefined,
          server: typeof res.headers.server === "string" ? res.headers.server : undefined,
        };
        if (!readBody || method === "HEAD") {
          res.destroy();
          resolve({ ...base, body: "" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          chunks.push(c);
          if (size >= MAX_KEYWORD_BODY) res.destroy();
        });
        const done = () => resolve({ ...base, body: Buffer.concat(chunks).toString("utf8") });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function reasonOf(e: unknown): string {
  // Duck-typed: an error thrown by node core can come from another realm (instanceof Error is false there).
  if (e && typeof e === "object") {
    const err = e as { name?: string; message?: string; code?: string; errors?: Array<{ code?: string }> };
    if (err.name === "AbortError") return "timeout";
    return err.message || err.code || err.errors?.[0]?.code || "request failed";
  }
  return "request failed";
}

export const httpCheck: Checker = async (m, opts) => {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), m.timeoutMs);
  try {
    let url = new URL(m.target);
    let method = (m.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { "user-agent": "TugraUptime/1.0" };
    for (const [k, v] of Object.entries(opts?.headers ?? {})) headers[k.toLowerCase()] = v;
    if (opts?.basicAuth) {
      headers.authorization = "Basic " + Buffer.from(`${opts.basicAuth.user}:${opts.basicAuth.pass}`).toString("base64");
    }
    let body = opts?.body !== undefined && opts.body !== "" ? opts.body : undefined;
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    const needBody = m.type === "KEYWORD";
    const max = Math.max(0, m.maxRedirects ?? 10);
    let res: RawResponse | null = null;
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { up: false, ms: Date.now() - start, msg: `unsupported protocol ${url.protocol}` };
      }
      res = await requestOnce(url, method, headers, body, needBody, m.ignoreTls, ctrl.signal);
      if (!REDIRECTS.has(res.status) || !res.location || max === 0) break;
      if (hop >= max) {
        return { up: false, ms: Date.now() - start, msg: "too many redirects" };
      }
      const next = new URL(res.location, url);
      if (next.host !== url.host) {
        delete headers.authorization; // never forward credentials to another host
        delete headers.cookie;
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
        delete headers["content-length"];
        delete headers["content-type"];
      }
      url = next;
    }
    clearTimeout(timer);
    const ms = Date.now() - start;
    const ok = statusAccepted(res.status, m.acceptedStatus);
    if (!ok) {
      const cause = cloudflareCause(res.status);
      return {
        up: false,
        ms,
        msg: cause ? cloudflareSummary(res.status) : `HTTP ${res.status}`,
        ...(cause ? { cause } : {}),
      };
    }
    if (needBody) {
      const kw = m.keyword ?? "";
      const found = res.body.includes(kw);
      const invert = m.keywordInvert === true;
      if (found === invert) {
        return {
          up: false,
          ms,
          msg: invert ? `HTTP ${res.status}, keyword present` : `HTTP ${res.status}, keyword not found`,
        };
      }
    }
    return { up: true, ms, msg: `HTTP ${res.status}` };
  } catch (e) {
    clearTimeout(timer);
    return { up: false, ms: Date.now() - start, msg: reasonOf(e) };
  }
};

export const tcpCheck: Checker = (m) =>
  new Promise<CheckResult>((resolve) => {
    const start = Date.now();
    const [host, portStr] = m.target.split(":");
    const sock = net.connect({ host, port: Number(portStr) });
    const done = (up: boolean, msg: string) => {
      sock.destroy();
      resolve({ up, ms: Date.now() - start, msg });
    };
    sock.setTimeout(m.timeoutMs);
    sock.once("connect", () => done(true, "connected"));
    sock.once("timeout", () => done(false, "timeout"));
    sock.once("error", (e) => done(false, e.message));
  });

/** A hostname or IP literal that is safe to hand to the `ping` binary as a plain argument. */
export const PING_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/;

export const pingCheck: Checker = (m) =>
  new Promise<CheckResult>((resolve) => {
    const start = Date.now();
    if (!PING_HOST_RE.test(m.target)) {
      resolve({ up: false, ms: 0, msg: "invalid host" });
      return;
    }
    const wait = String(Math.max(1, Math.ceil(m.timeoutMs / 1000)));
    execFile("ping", ["-c", "1", "-W", wait, m.target], { timeout: m.timeoutMs + 2000 }, (err, stdout) => {
      const took = /time[=<]\s*([\d.]+)\s*ms/i.exec(String(stdout));
      const ms = took ? Math.round(Number(took[1])) : Date.now() - start;
      if (!err) return resolve({ up: true, ms, msg: "reply received" });
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return resolve({ up: false, ms: 0, msg: "ping is not available on this hub" });
      }
      resolve({ up: false, ms: Date.now() - start, msg: "no reply" });
    });
  });

const DNS_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "CAA", "PTR"]);

/** Flatten any resolver answer shape to comparable strings. */
export function dnsAnswers(type: string, answer: unknown): string[] {
  const list = Array.isArray(answer) ? answer : [answer];
  return list.map((a) => {
    if (typeof a === "string") return a;
    if (Array.isArray(a)) return a.join("");
    if (a && typeof a === "object") {
      const o = a as Record<string, unknown>;
      if (type === "MX") return `${o.priority} ${o.exchange}`;
      if (type === "SRV") return `${o.priority} ${o.weight} ${o.port} ${o.name}`;
      return JSON.stringify(a);
    }
    return String(a);
  });
}

export const dnsCheck: Checker = async (m) => {
  const start = Date.now();
  const type = (m.dnsRecordType ?? "A").toUpperCase();
  if (!DNS_TYPES.has(type)) return { up: false, ms: 0, msg: `unsupported record type ${type}` };
  try {
    const resolver = new Resolver({ timeout: Math.max(1000, m.timeoutMs), tries: 1 });
    if (m.dnsServer) resolver.setServers([m.dnsServer]);
    const answer = await resolver.resolve(m.target, type as "A");
    const values = dnsAnswers(type, answer);
    const ms = Date.now() - start;
    const text = `${type}: ${values.join(", ")}`.slice(0, 300);
    if (m.dnsExpect && !values.some((v) => v.includes(m.dnsExpect as string))) {
      return { up: false, ms, msg: `${text} (expected ${m.dnsExpect})` };
    }
    return { up: values.length > 0, ms, msg: text };
  } catch (e) {
    return { up: false, ms: Date.now() - start, msg: reasonOf(e) };
  }
};

export const checkers: Record<string, Checker> = {
  HTTP: httpCheck,
  KEYWORD: httpCheck,
  TCP: tcpCheck,
  PING: pingCheck,
  DNS: dnsCheck,
};

export type MetricKind = "DISK" | "CPU" | "MEM";

export interface MetricSampleLite {
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
}

/**
 * Evaluate a server metric against a threshold. Pure (no DB) so it's unit-testable; the runner fetches the
 * latest sample and passes it in with its timestamp. A metric monitor can only CONFIRM health from a RECENT
 * sample, so a stale/absent sample counts as a FAILED check — never a recovery (the old code read the latest
 * row with no freshness gate, so a stale low row could flip a DOWN monitor back to UP, and after the 48h
 * retention purge an absent row did the same). `freshness` is optional for backward compatibility — when the
 * caller omits the timestamp, the behaviour is the original pure threshold check.
 */
export function metricCheckResult(
  kind: MetricKind,
  sample: MetricSampleLite | null,
  thresholdPct: number,
  freshness?: { ts?: number | Date | null; now?: number; maxAgeMs?: number; noDataIsDown?: boolean },
): CheckResult {
  if (!sample) {
    // No sample row. A monitor that is already alarming must NOT "recover" from the ABSENCE of data (e.g. after
    // the retention purge deletes a silent agent's rows). Only a monitor that has never seen a sample stays UP
    // ("no metrics yet"), so a just-created monitor doesn't false-alarm before the first sample arrives.
    if (freshness?.noDataIsDown) return { up: false, ms: 0, msg: "no metrics (agent not reporting)" };
    return { up: true, ms: 0, msg: "no metrics yet" };
  }
  // Freshness gate (active whenever the caller asks for it — i.e. supplies now + maxAgeMs; omitting the whole
  // `freshness` arg keeps the legacy pure-threshold behaviour for old callers). A sample that is stale,
  // future-dated (clock skew), or of unknown age can't confirm the resource is below the threshold RIGHT NOW,
  // so it counts as a failure, never a recovery. Fail CLOSED on a bad timestamp, not open.
  if (freshness && freshness.now != null && freshness.maxAgeMs != null) {
    const tsMs = freshness.ts instanceof Date ? freshness.ts.getTime() : freshness.ts != null ? Number(freshness.ts) : NaN;
    if (!Number.isFinite(tsMs)) return { up: false, ms: 0, msg: "unknown sample age" };
    const age = freshness.now - tsMs;
    if (age > freshness.maxAgeMs) return { up: false, ms: 0, msg: `stale metrics (${Math.round(age / 1000)}s old)` };
    if (tsMs > freshness.now + 60_000) return { up: false, ms: 0, msg: "metric timestamp in the future (clock skew)" };
  }
  let pct: number;
  if (kind === "CPU") pct = sample.cpu;
  else if (kind === "MEM") pct = sample.memTotal > 0 ? (sample.memUsed / sample.memTotal) * 100 : 0;
  else pct = sample.diskTotal > 0 ? (sample.diskUsed / sample.diskTotal) * 100 : 0;
  const rounded = Math.round(pct);
  return {
    up: rounded < thresholdPct,
    ms: 0,
    msg: `${kind} ${rounded}% (limit ${thresholdPct}%)`,
  };
}
