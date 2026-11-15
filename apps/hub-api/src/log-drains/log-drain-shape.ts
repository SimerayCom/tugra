import { BadRequestException } from "@nestjs/common";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { HTTP_DRAIN_TYPES, NET_DRAIN_TYPES } from "../server-ops/dto";
import { classifyHost, normalizeHost } from "./log-drain-address";

export type DrainScope = "server" | "app";
export type NormalizedOptions = Record<string, unknown>;

export interface ShapeInput {
  type: string;
  endpoint: string;
  options?: unknown;
  scope: DrainScope;
  allowPrivate: boolean;
  /** Whether the drain (after this write) carries a token. syslog/gelf have no auth, so a token is refused. */
  hasToken?: boolean;
}

export function isHttpDrainType(type: string): boolean {
  return (HTTP_DRAIN_TYPES as readonly string[]).includes(type.toLowerCase());
}
export function isNetDrainType(type: string): boolean {
  return (NET_DRAIN_TYPES as readonly string[]).includes(type);
}

function bad(message: string): never {
  throw new BadRequestException(message);
}

// ---- endpoint parsing ----

const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** RFC 1123 hostname (labels of letters/digits/hyphen). A final label that is all digits is refused unless the
 *  whole string is a dotted IPv4: it is how `2130706433` / `127.1` style numeric-IP tricks are spelled. */
export function isHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  const labels = h.split(".");
  if (!labels.every((l) => HOSTNAME_LABEL.test(l))) return false;
  if (/^\d+$/.test(labels[labels.length - 1]) && isIP(h) !== 4) return false;
  return true;
}

/** Split a `host:port` / `[v6]:port` / `ipv4:port` endpoint; no scheme, path, query or userinfo. */
export function parseHostPort(endpoint: string): { host: string; port: number } {
  const e = endpoint.trim();
  if (e !== endpoint || e === "") bad("endpoint must be host:port without surrounding whitespace");
  if (/[/?#@\s]|:\/\//.test(e)) bad("endpoint must be host:port (no scheme, path or credentials)");
  let host: string;
  let portStr: string;
  if (e.startsWith("[")) {
    const m = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(e);
    if (!m || isIP(m[1]) !== 6) bad("endpoint must be [IPv6]:port");
    host = m![1];
    portStr = m![2];
  } else {
    const idx = e.lastIndexOf(":");
    if (idx <= 0 || e.indexOf(":") !== idx) bad("endpoint must be host:port");
    host = e.slice(0, idx);
    portStr = e.slice(idx + 1);
    if (!/^\d{1,5}$/.test(portStr)) bad("endpoint port must be a number");
    if (isIP(host) === 0 && !isHostname(host)) bad("endpoint host is not a valid hostname or IP address");
  }
  const port = Number(portStr);
  if (port < 1 || port > 65535) bad("endpoint port must be between 1 and 65535");
  return { host, port };
}

/** Literal-address guard (UX pre-check; the agent's dial guard on the resolved IP is authoritative). */
function guardHost(host: string, scope: DrainScope, allowPrivate: boolean): void {
  const cls = classifyHost(host);
  if (cls === "blocked") bad("endpoint address is not allowed (metadata, link-local, unspecified or multicast)");
  if (cls === "private" && scope === "app" && !allowPrivate) bad("private address needs allowPrivate");
}

// ---- per-transport options ----

const SERVER_NAME = z.string().min(1).max(253);
const OPT_KEYS = { caCert: z.string().min(1).max(16384).optional(), serverName: SERVER_NAME.optional() };

const SyslogOptions = z
  .object({
    proto: z.enum(["udp", "tcp", "tls"]),
    facility: z.number().int().min(0).max(23).optional(),
    framing: z.enum(["octet", "newline"]).optional(),
    appName: z.string().regex(/^[A-Za-z0-9._-]{1,48}$/).optional(),
    ...OPT_KEYS,
  })
  .strict();

const GelfOptions = z
  .object({
    proto: z.enum(["udp", "tcp", "tls"]),
    compress: z.enum(["none", "gzip", "zlib"]).optional(),
    ...OPT_KEYS,
  })
  .strict();

const FluentdOptions = z
  .object({
    proto: z.enum(["tcp", "tls"]),
    tag: z.string().regex(/^[A-Za-z0-9_-]{1,32}(\.[A-Za-z0-9_-]{1,32}){0,3}$/).optional(),
    requireAck: z.boolean().optional(),
    ...OPT_KEYS,
  })
  .strict();

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g;

/** Validate a PEM bundle of at most 4 CERTIFICATE blocks (each parsed with node's X509Certificate) and nothing
 *  else (a private key pasted by mistake is refused). Returns the normalised bundle. */
export function normalizeCaCert(pem: string): string {
  const blocks = pem.match(PEM_BLOCK) ?? [];
  if (blocks.length === 0) bad("caCert must contain a PEM CERTIFICATE");
  if (blocks.length > 4) bad("caCert may contain at most 4 certificates");
  if (pem.replace(PEM_BLOCK, "").trim() !== "") bad("caCert must contain only PEM CERTIFICATE blocks");
  for (const b of blocks) {
    try {
      new X509Certificate(b);
    } catch {
      bad("caCert contains an invalid certificate");
    }
  }
  return blocks.map((b) => b.trim()).join("\n") + "\n";
}

function zodMessage(e: z.ZodError): string {
  const i = e.issues[0];
  if (i.code === "unrecognized_keys") return `options: unknown key ${(i as { keys: string[] }).keys.join(", ")} (secrets belong in the token field, not options)`;
  return i.path.length ? `options.${i.path.join(".")}: ${i.message}` : `options: ${i.message}`;
}

function tlsOnly(o: { proto: string; caCert?: string; serverName?: string }): void {
  if (o.proto !== "tls" && (o.caCert !== undefined || o.serverName !== undefined)) bad("caCert and serverName are only valid with proto: tls");
}

function parseOptions(type: string, raw: unknown): NormalizedOptions {
  const run = <T>(schema: z.ZodType<T>): T => {
    const r = schema.safeParse(raw);
    if (!r.success) bad(zodMessage(r.error));
    return r.data;
  };
  if (type === "syslog") {
    const o = run(SyslogOptions);
    tlsOnly(o);
    if (o.proto === "udp" && o.framing !== undefined) bad("framing only applies to tcp and tls");
    return {
      proto: o.proto,
      facility: o.facility ?? 16,
      ...(o.proto === "udp" ? {} : { framing: o.framing ?? (o.proto === "tls" ? "octet" : "newline") }),
      ...(o.appName !== undefined ? { appName: o.appName } : {}),
      ...(o.caCert !== undefined ? { caCert: normalizeCaCert(o.caCert) } : {}),
      ...(o.serverName !== undefined ? { serverName: o.serverName } : {}),
    };
  }
  if (type === "gelf") {
    const o = run(GelfOptions);
    tlsOnly(o);
    if (o.proto !== "udp" && o.compress !== undefined && o.compress !== "none") bad("compress must be none for tcp and tls");
    return {
      proto: o.proto,
      compress: o.proto === "udp" ? (o.compress ?? "gzip") : "none",
      ...(o.caCert !== undefined ? { caCert: normalizeCaCert(o.caCert) } : {}),
      ...(o.serverName !== undefined ? { serverName: o.serverName } : {}),
    };
  }
  const o = run(FluentdOptions);
  tlsOnly(o);
  return {
    proto: o.proto,
    tag: o.tag ?? "tugra",
    requireAck: o.requireAck ?? true,
    ...(o.caCert !== undefined ? { caCert: normalizeCaCert(o.caCert) } : {}),
    ...(o.serverName !== undefined ? { serverName: o.serverName } : {}),
  };
}

function isEmptyObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v as object).length === 0;
}

/**
 * Validate the (merged) type/endpoint/options of a drain and return the normalised options (defaults filled).
 * Throws BadRequestException with an actionable message. Pure: no I/O.
 */
export function validateDrainShape(input: ShapeInput): { options: NormalizedOptions | null } {
  const type = input.type.toLowerCase();
  if (isHttpDrainType(type)) {
    if (input.options != null && !isEmptyObject(input.options)) bad("options are not supported for http, loki and datadog drains");
    let url: URL;
    try {
      url = new URL(input.endpoint);
    } catch {
      return bad("endpoint must be a valid http(s) URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") bad("endpoint must be an http(s) URL");
    if (!url.hostname) bad("endpoint must be a valid http(s) URL");
    guardHost(url.hostname, input.scope, input.allowPrivate);
    return { options: null };
  }
  if (!isNetDrainType(type)) bad(`unknown drain type ${input.type}`);
  if (type !== "fluentd" && input.hasToken) bad(`${type} has no authentication: remove the token`);
  if (input.options == null) bad(`${type} drains need options (proto is required)`);
  const { host } = parseHostPort(input.endpoint);
  guardHost(normalizeHost(host), input.scope, input.allowPrivate);
  return { options: parseOptions(type, input.options) };
}

// ---- container filter ----

const SERVER_GLOB = /^[A-Za-z0-9_.*?-]{1,128}$/;
const APP_SERVICE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/**
 * Validate the container filter for a scope. Server scope: container-name globs. App scope: compose service
 * names, only for a non-clustered COMPOSE app (a non-empty list is refused otherwise, never silently ignored).
 * Returns the de-duplicated list in input order.
 */
export function validateContainers(
  scope: DrainScope,
  containers: string[],
  app?: { source: string; clusterId: string | null },
): string[] {
  const list = [...new Set(containers)];
  if (list.length === 0) return [];
  if (scope === "server") {
    for (const c of list) if (!SERVER_GLOB.test(c)) bad(`container filter "${c}" may only contain letters, digits, _ . - and the wildcards * ?`);
    return list;
  }
  if (!app || app.source !== "COMPOSE" || app.clusterId) bad("container filter only applies to compose apps");
  for (const c of list) if (!APP_SERVICE.test(c)) bad(`"${c}" is not a valid compose service name`);
  return list;
}
