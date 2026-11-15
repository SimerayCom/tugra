import type { LogDrain, LogDrainInput, LogDrainType } from "../../lib/types";

/** Pure model of the drain form: drafts, payload building and validation (no React, no i18n strings: validateDraft
 *  returns an i18n key the caller passes through t()). */

export const HTTP_TYPES: readonly LogDrainType[] = ["http", "loki", "datadog"];
export const NET_TYPES: readonly LogDrainType[] = ["syslog", "gelf", "fluentd"];
export const ALL_TYPES: readonly LogDrainType[] = [...HTTP_TYPES, ...NET_TYPES];

export type Proto = "udp" | "tcp" | "tls";
/** Protocols each NET type offers (fluentd Forward has no UDP mode). */
export const TYPE_PROTOS: Record<"syslog" | "gelf" | "fluentd", readonly Proto[]> = {
  syslog: ["udp", "tcp", "tls"],
  gelf: ["udp", "tcp", "tls"],
  fluentd: ["tcp", "tls"],
};
/** Default port per NET type (the conventional listener). */
export const DEFAULT_PORT: Record<"syslog" | "gelf" | "fluentd", string> = { syslog: "514", gelf: "12201", fluentd: "24224" };

export type DrainScopeKind = "server" | "app";

export interface DrainDraft {
  name: string;
  type: LogDrainType;
  /** http/loki/datadog: the full URL. Ignored for the NET types (host + port below). */
  endpoint: string;
  host: string;
  port: string;
  /** http/loki/datadog bearer, or the fluentd shared key. Blank on edit = keep the stored one. */
  token: string;
  proto: Proto;
  facility: string;
  framing: "" | "octet" | "newline";
  appName: string;
  compress: "none" | "gzip" | "zlib";
  tag: string;
  requireAck: boolean;
  caCert: string;
  serverName: string;
  containers: string[];
  allowPrivate: boolean;
}

export function isNetType(type: string): type is "syslog" | "gelf" | "fluentd" {
  return type === "syslog" || type === "gelf" || type === "fluentd";
}

export function emptyDraft(type: LogDrainType = "http"): DrainDraft {
  const net = isNetType(type);
  return {
    name: "",
    type,
    endpoint: "",
    host: "",
    port: net ? DEFAULT_PORT[type] : "",
    token: "",
    proto: net ? TYPE_PROTOS[type][0] : "udp",
    facility: "16",
    framing: "",
    appName: "",
    compress: "gzip",
    tag: "tugra",
    requireAck: true,
    caCert: "",
    serverName: "",
    containers: [],
    allowPrivate: false,
  };
}

/** Switch the type of a draft: keeps what is common (name, filter, token) and resets the type-specific fields. */
export function withType(draft: DrainDraft, type: LogDrainType): DrainDraft {
  const next = emptyDraft(type);
  const keepToken = HTTP_TYPES.includes(draft.type) && HTTP_TYPES.includes(type); // a bearer never turns into a shared key
  return { ...next, name: draft.name, containers: draft.containers, allowPrivate: draft.allowPrivate, token: keepToken ? draft.token : "" };
}

/** `host:port`, `[v6]:port` or `ipv4:port` -> parts (empty strings when it does not parse). */
export function splitEndpoint(endpoint: string): { host: string; port: string } {
  const e = endpoint.trim();
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(e);
  if (v6) return { host: v6[1], port: v6[2] };
  const i = e.lastIndexOf(":");
  if (i > 0 && e.indexOf(":") === i) return { host: e.slice(0, i), port: e.slice(i + 1) };
  return { host: e, port: "" };
}

/** Inverse of splitEndpoint: an IPv6 literal (contains ":") is bracketed. */
export function joinEndpoint(host: string, port: string): string {
  const h = host.trim();
  const needsBrackets = h.includes(":") && !h.startsWith("[");
  return `${needsBrackets ? `[${h}]` : h}:${port.trim()}`;
}

/** Rebuild an editable draft from a stored drain (the token and shared key are never returned: blank = keep). */
export function draftFromDrain(d: LogDrain): DrainDraft {
  const type = (ALL_TYPES as readonly string[]).includes(d.type.toLowerCase()) ? (d.type.toLowerCase() as LogDrainType) : "http";
  const base = emptyDraft(type);
  const o = (d.options ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const draft: DrainDraft = { ...base, name: d.name, containers: [...(d.containers ?? [])], allowPrivate: d.allowPrivate ?? false };
  if (!isNetType(type)) return { ...draft, endpoint: d.endpoint };
  const { host, port } = splitEndpoint(d.endpoint);
  return {
    ...draft,
    host,
    port: port || base.port,
    proto: (str("proto") as Proto | undefined) ?? base.proto,
    facility: typeof o.facility === "number" ? String(o.facility) : base.facility,
    framing: (str("framing") as DrainDraft["framing"] | undefined) ?? "",
    appName: str("appName") ?? "",
    compress: (str("compress") as DrainDraft["compress"] | undefined) ?? base.compress,
    tag: str("tag") ?? base.tag,
    requireAck: typeof o.requireAck === "boolean" ? o.requireAck : true,
    caCert: str("caCert") ?? "",
    serverName: str("serverName") ?? "",
  };
}

/** Per-type `options` object (never a secret: the token goes in the `token` field). Only meaningful values are
 *  sent; the hub fills the defaults. */
export function buildOptions(draft: DrainDraft): Record<string, unknown> | undefined {
  if (!isNetType(draft.type)) return undefined;
  const o: Record<string, unknown> = { proto: draft.proto };
  if (draft.type === "syslog") {
    const f = draft.facility.trim();
    if (f !== "") o.facility = Number(f);
    if (draft.proto !== "udp" && draft.framing) o.framing = draft.framing;
    if (draft.appName.trim()) o.appName = draft.appName.trim();
  } else if (draft.type === "gelf") {
    if (draft.proto === "udp") o.compress = draft.compress;
  } else {
    if (draft.tag.trim()) o.tag = draft.tag.trim();
    o.requireAck = draft.requireAck;
  }
  if (draft.proto === "tls") {
    if (draft.caCert.trim()) o.caCert = draft.caCert.trim();
    if (draft.serverName.trim()) o.serverName = draft.serverName.trim();
  }
  return o;
}

/** What a stored token MEANS per type: a bearer (http/loki/datadog), a fluentd shared key, or nothing (syslog/gelf).
 *  A stored token only stays valid inside one group. */
export function tokenGroup(type: string): "bearer" | "sharedKey" | "none" {
  if (type === "fluentd") return "sharedKey";
  if (type === "syslog" || type === "gelf") return "none";
  return "bearer";
}

/** True when an edit moves a drain with a stored token across token groups: the old secret must not silently
 *  change meaning (bearer -> shared key) or block the save (syslog/gelf refuse a token). */
export function tokenDropsOnTypeChange(original: { type: string; hasToken: boolean } | undefined, draft: DrainDraft): boolean {
  return !!original?.hasToken && tokenGroup(original.type.toLowerCase()) !== tokenGroup(draft.type);
}

/**
 * Request body for create (`mode: "create"`) or edit. Create omits an empty token; edit omits it too (blank = keep
 * the stored one) unless the type moves across token groups, which clears it (`token: null`). The container filter is always sent so a cleared filter clears on the hub. `allowPrivate` is
 * an app-scope field only. syslog/gelf never carry a token.
 */
export function draftToPayload(
  draft: DrainDraft,
  scope: DrainScopeKind,
  original?: { type: string; hasToken: boolean },
): LogDrainInput & { name: string; endpoint: string } {
  const net = isNetType(draft.type);
  const payload: LogDrainInput & { name: string; endpoint: string } = {
    name: draft.name.trim(),
    type: draft.type,
    endpoint: net ? joinEndpoint(draft.host, draft.port) : draft.endpoint.trim(),
    containers: draft.containers,
  };
  const options = buildOptions(draft);
  if (options) payload.options = options;
  const canHaveToken = !net || draft.type === "fluentd";
  if (canHaveToken && draft.token) payload.token = draft.token;
  // Edit across token groups: the stored secret is cleared explicitly (blank otherwise means "keep").
  else if (tokenDropsOnTypeChange(original, draft)) payload.token = null;
  if (scope === "app") payload.allowPrivate = draft.allowPrivate;
  return payload;
}

const APP_SERVICE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const SERVER_GLOB = /^[A-Za-z0-9_.*?-]{1,128}$/;
const TAG = /^[A-Za-z0-9_-]{1,32}(\.[A-Za-z0-9_-]{1,32}){0,3}$/;
const APP_NAME = /^[A-Za-z0-9._-]{1,48}$/;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function isValidContainerEntry(entry: string, scope: DrainScopeKind): boolean {
  return (scope === "app" ? APP_SERVICE : SERVER_GLOB).test(entry);
}

function isHostLike(host: string): boolean {
  const h = host.trim();
  if (!h || /[\s/?#@]|:\/\//.test(h)) return false;
  if (h.includes(":")) return /^[0-9A-Fa-f:.]+$/.test(h.replace(/^\[|\]$/g, "")); // an IPv6 literal
  return h.split(".").every((l) => HOST_LABEL.test(l));
}

/** The first problem with a draft as an i18n key (`logdrains.validation_*`), or null when it is fine. The hub
 *  re-validates everything (this only saves a round trip and explains what is wrong in plain words). */
export function validateDraft(draft: DrainDraft, scope: DrainScopeKind): string | null {
  if (!draft.name.trim()) return "logdrains.validation_name";
  if (!isNetType(draft.type)) {
    try {
      const u = new URL(draft.endpoint.trim());
      if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return "logdrains.validation_url";
    } catch {
      return "logdrains.validation_url";
    }
  } else {
    if (!isHostLike(draft.host)) return "logdrains.validation_host";
    const port = Number(draft.port);
    if (!/^\d{1,5}$/.test(draft.port.trim()) || port < 1 || port > 65535) return "logdrains.validation_port";
    if (draft.type === "syslog") {
      const f = draft.facility.trim();
      if (f !== "" && (!/^\d{1,2}$/.test(f) || Number(f) > 23)) return "logdrains.validation_facility";
      if (draft.appName.trim() && !APP_NAME.test(draft.appName.trim())) return "logdrains.validation_appName";
    }
    if (draft.type === "fluentd" && draft.tag.trim() && !TAG.test(draft.tag.trim())) return "logdrains.validation_tag";
    if (draft.proto === "tls") {
      if (draft.caCert.trim() && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(draft.caCert)) return "logdrains.validation_caCert";
      const sn = draft.serverName.trim();
      if (sn && !isHostLike(sn)) return "logdrains.validation_serverName";
    }
  }
  for (const c of draft.containers) {
    if (!isValidContainerEntry(c, scope)) return scope === "app" ? "logdrains.validation_container_app" : "logdrains.validation_container_server";
  }
  return null;
}
