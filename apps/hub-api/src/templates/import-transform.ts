// Pure, testable compose transforms shared by the build-time importer
// (scripts/import-templates.mjs imports the COMPILED dist of this file) and gated by jest. It maps a
// Coolify service compose into Tugra's baked catalog shape AND derives the rich install-time metadata
// (exposure[] for host-port publishing, later mounts[]/variables[]). No I/O — the importer handles
// fetch/base64/write; this file is string surgery only, so it stays type-checked + unit-tested.
import type { SecretKind } from "./catalog";
import type { ExposePort } from "./template-manifest";

export const HOST_PORT_BASE = 20000; // synthesized host ports start here (curated use < 20000)

export const DB_IMAGES =
  /(postgres|postgis|pgvector|mysql|mariadb|percona|redis|valkey|keydb|dragonfly|mongo|clickhouse|memcached|rabbitmq|nats|meilisearch|typesense|elasticsearch|opensearch|qdrant|weaviate|minio|etcd|couchdb|influxdb|timescale)/i;

const CATEGORIES = new Set([
  "cms", "automation", "database", "monitoring", "tools",
  "analytics", "security", "productivity", "developer",
  "ai", "media", "communication", "finance",
]);
const CATEGORY_KEYWORDS: [string, RegExp][] = [
  ["ai", /\b(ai|llm|gpt|machine learning|ml|chatbot|rag|embedding|ollama|vector)\b/i],
  ["analytics", /\b(analytic|metrics|telemetry|tracking|bi|dashboard)\b/i],
  ["monitoring", /\b(monitor|uptime|observability|status|alert|log)\b/i],
  ["security", /\b(password|secret|vault|auth|sso|identity|vpn|firewall|security|2fa)\b/i],
  ["communication", /\b(chat|mail|email|messaging|forum|comment|notification|sms)\b/i],
  ["finance", /\b(budget|invoice|finance|accounting|money|expense|crypto|wallet)\b/i],
  ["media", /\b(media|video|music|audio|photo|gallery|stream|podcast|book|ebook|movie)\b/i],
  ["developer", /\b(git|ci|cd|devops|database admin|api|backend|deploy|registry|code)\b/i],
  ["automation", /\b(automation|workflow|no.?code|low.?code|cron|scheduler)\b/i],
  ["cms", /\b(cms|blog|wiki|content|publishing|docs|documentation|website)\b/i],
  ["productivity", /\b(productivity|notes|todo|calendar|kanban|project|crm|files|cloud|office|recipe|bookmark)\b/i],
];

export function mapCategory(coolifyCategory?: string, tags?: string[]): string {
  const hay = `${coolifyCategory ?? ""} ${(tags ?? []).join(" ")}`;
  if (coolifyCategory && CATEGORIES.has(String(coolifyCategory).toLowerCase()))
    return String(coolifyCategory).toLowerCase();
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(hay)) return cat;
  return "tools";
}

export function titleize(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => (w.length <= 3 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

type Classified =
  | { type: "fqdn" | "url"; key: string }
  | { type: "secret"; key: string; kind: SecretKind; len?: number };

/** Classify a SERVICE_* magic token → secret descriptor or a url/fqdn literal. Returns null for a
 *  token we cannot map (the caller skips that template). v2 widens the table to recover templates
 *  that use bare `PASSWORD`/`FQDN`, `PUBLICURL_`, and `*API_KEY` tokens. Genuine config flags
 *  (DISABLE_*, *_NAME, ID) stay unmapped on purpose — they are user config, not generated secrets. */
export function classifyToken(token: string): Classified | null {
  const body = token.replace(/^SERVICE_/, ""); // PASSWORD_64_X, URL_APP, FQDN, ...
  const lenMatch = body.match(/_(\d{2,3})_/);
  const len = lenMatch ? Number(lenMatch[1]) : undefined;
  const key = body; // env key, no SERVICE_ prefix → no magic token remains
  if (/^FQDN(_|$)/.test(body)) return { type: "fqdn", key };
  if (/^URL(_|$)/.test(body)) return { type: "url", key };
  if (/^PUBLICURL(_|$)/.test(body)) return { type: "url", key };
  if (/^PASSWORDWITHSYMBOLS(_|$)/.test(body)) return { type: "secret", key, kind: "password-symbols", len: len ?? 32 };
  if (/^PASSWORD(_|$)/.test(body)) return { type: "secret", key, kind: "alnum", len: len ?? 32 };
  if (/^USER(_|$)/.test(body)) return { type: "secret", key, kind: "alnum", len: len ?? 16 };
  if (/^REALBASE64(_|$)/.test(body)) return { type: "secret", key, kind: "base64", len: len ?? 32 };
  if (/^BASE64(_|$)/.test(body)) return { type: "secret", key, kind: "alnum", len: len ?? 32 };
  if (/^HEX(_|$)/.test(body)) return { type: "secret", key, kind: "hex", len: len ?? 32 };
  if (/API_?KEY/.test(body)) return { type: "secret", key, kind: "alnum", len: len ?? 32 };
  return null; // unmapped SERVICE_ token → caller skips
}

function urlLiteral(c: { type: string }, hostPort: number): string {
  return c.type === "url" ? `http://localhost:${hostPort}` : `localhost:${hostPort}`;
}

function leadingSpaces(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/** Remove an indented block that starts at the matched header line. */
function stripBlock(text: string, headerRe: RegExp): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (!m) { out.push(lines[i]); continue; }
    const indent = m[1].length;
    i++;
    while (i < lines.length && (lines[i].trim() === "" || leadingSpaces(lines[i]) > indent)) i++;
    i--; // re-process the dedented line
  }
  return out.join("\n");
}

function nextServiceStart(lines: string[], from: number, svcIndent: number): number {
  for (let i = from + 1; i < lines.length; i++) {
    const ls = leadingSpaces(lines[i]);
    if (lines[i].trim() !== "" && ls <= svcIndent) return i;
  }
  return lines.length;
}

/** The web container port for the main service. Priority: explicit meta.port → the port suffix of a
 *  `SERVICE_(FQDN|URL)_<svc>_<port>` magic token (Coolify's web-port convention, e.g. gitea's 3000) →
 *  an `expose:` entry → the container side of an own `ports:` mapping. 0 when none (a portless
 *  sidecar the caller skips). */
export function deriveContainerPort(raw: string, metaPort?: number | string | null): number {
  const explicit = Number(metaPort);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const magic = raw.match(/SERVICE_(?:FQDN|URL)_[A-Z0-9]+_(\d{2,5})/);
  if (magic) return Number(magic[1]);
  const exp = raw.match(/expose:\s*\n\s*-\s*["']?(\d+)/);
  if (exp) return Number(exp[1]);
  const pub = firstPublishedContainerPort(raw);
  return pub || 0;
}

/** Container side (last colon field) of the first published `ports:` mapping on a NON-DATABASE
 *  service — mirrors injectPorts' DB filter so a database port (e.g. postgres 5432 listed before the
 *  web service) is never mistaken for the web port. */
function firstPublishedContainerPort(text: string): number {
  const lines = text.split("\n");
  const svcIdx = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (svcIdx === -1) return 0;
  const serviceLineRe = /^(\s+)([A-Za-z0-9._-]+):\s*$/;
  let svcIndent: number | null = null;
  const services: { line: number }[] = [];
  for (let i = svcIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const ls = leadingSpaces(lines[i]);
    if (ls === 0) break;
    const m = lines[i].match(serviceLineRe);
    if (svcIndent === null && m) svcIndent = ls;
    if (m && ls === svcIndent) services.push({ line: i });
  }
  if (svcIndent === null) return 0;
  for (const s of services) {
    const end = nextServiceStart(lines, s.line, svcIndent);
    const block = lines.slice(s.line, end);
    const img = block.join("\n").match(/image:\s*["']?([^"'\s]+)/);
    if (img && DB_IMAGES.test(img[1])) continue; // never derive the web port from a database service
    for (let j = 1; j < block.length; j++) {
      if (!/^\s+ports:\s*$/.test(block[j])) continue;
      const indent = leadingSpaces(block[j]);
      for (let k = j + 1; k < block.length; k++) {
        if (block[k].trim() === "") continue;
        if (leadingSpaces(block[k]) <= indent) break;
        const m = block[k].match(/["']?[\d.]*:?(\d+)(?:\/(?:tcp|udp))?["']?\s*$/);
        const container = m?.[1] ?? block[k].match(/(\d+)/)?.[1];
        if (container) return Number(container);
      }
    }
  }
  return 0;
}

/** Insert `ports: - "<host>:<container>"` under the first non-database service; returns the modified
 *  text plus the exposed {serviceName, containerPort} (null when no service could be targeted). */
function injectPorts(
  text: string,
  hostPort: number,
  containerPort: number,
): { text: string; service: string | null } {
  const lines = text.split("\n");
  const svcIdx = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (svcIdx === -1) return { text, service: null };
  const serviceLineRe = /^(\s+)([A-Za-z0-9._-]+):\s*$/;
  let svcIndent: number | null = null;
  const services: { name: string; line: number }[] = [];
  for (let i = svcIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const ls = leadingSpaces(l);
    if (ls === 0) break;
    const m = l.match(serviceLineRe);
    if (svcIndent === null && m) svcIndent = ls;
    if (m && ls === svcIndent) services.push({ name: m[2], line: i });
  }
  if (svcIndent === null || services.length === 0) return { text, service: null };
  let target = services[0];
  for (const s of services) {
    const blockEnd = nextServiceStart(lines, s.line, svcIndent);
    const block = lines.slice(s.line, blockEnd).join("\n");
    const img = block.match(/image:\s*["']?([^"'\s]+)/);
    if (!img || !DB_IMAGES.test(img[1])) { target = s; break; }
  }
  const childIndent = " ".repeat(svcIndent + 2);
  lines.splice(target.line + 1, 0, `${childIndent}ports:`, `${childIndent}  - "${hostPort}:${containerPort}"`);
  return { text: lines.join("\n"), service: target.name };
}

/** Declare any named volume referenced in a service-level `volumes:` block that is missing from the
 *  top-level `volumes:` — `docker compose up` errors on an undefined named volume. */
function declareNamedVolumes(text: string): string {
  const lines = text.split("\n");
  const referenced = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(\s+)volumes:\s*$/);
    if (!h) continue;
    const indent = h[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (leadingSpaces(lines[j]) <= indent) break;
      const m = lines[j].match(/^\s*-\s*["']?([A-Za-z0-9][A-Za-z0-9_.-]*):\//);
      if (m) referenced.add(m[1]);
    }
  }
  if (referenced.size === 0) return text;
  const declared = new Set<string>();
  const topIdx = lines.findIndex((l) => /^volumes:\s*$/.test(l));
  if (topIdx !== -1) {
    for (let i = topIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      if (leadingSpaces(lines[i]) === 0) break;
      const m = lines[i].match(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*):/);
      if (m) declared.add(m[1]);
    }
  }
  const missing = [...referenced].filter((v) => !declared.has(v));
  if (missing.length === 0) return text;
  const block = (topIdx === -1 ? ["volumes:"] : []).concat(missing.map((v) => `  ${v}:`));
  if (topIdx === -1) return text.replace(/\n*$/, "\n") + block.join("\n") + "\n";
  lines.splice(topIdx + 1, 0, ...block);
  return lines.join("\n");
}

export interface TransformedTemplate {
  compose: string;
  secrets: { key: string; kind?: SecretKind; len?: number }[];
  exposure: ExposePort[];
}

/**
 * Transform a raw Coolify compose into Tugra's baked catalog shape + exposure metadata, or throw
 * `{ skip }`. The host port stays baked (backward-compatible — the old install path is unchanged; the
 * install-time resolver rewrites it later). v2 recovers templates that carry their own `ports:`
 * (their published host ports are stripped and a single web port is re-published on the sequence,
 * keeping catalog-wide host-port uniqueness) but still skips inline `content:` mounts (recovered with
 * their materialization in a later slice).
 */
export function transformCompose(rawCompose: string, hostPort: number, containerPort: number): TransformedTemplate {
  let text = rawCompose;

  if (/^\s*content:/m.test(text)) throw { skip: "inline-content-mount" };
  if (/^\s*build:/m.test(text)) throw { skip: "build-context" };
  if (/^\s*(include|extends):/m.test(text)) throw { skip: "include/extends" };
  if (/source:\s*\.\.?\//.test(text) || /-\s*\.\.?\/[^\s:]+:/.test(text)) throw { skip: "relative-bind-mount" };

  // Recover own-ports: drop every published host port (incl. DB publishes — a DB must never publish
  // to the host) and re-publish a single web port on the assigned sequence port below. Handles both
  // block style (`ports:\n  - "x:y"`) and inline flow style (`ports: ["x:y"]` / `ports: "x:y"`).
  text = stripBlock(text, /^(\s+)ports:\s*$/m);
  text = text.split("\n").filter((l) => !/^\s+ports:\s*[[{"']/.test(l)).join("\n");

  text = stripBlock(text, /^(\s*)labels:\s*$/m); // proxy labels — unused

  // Boundary lookbehind: `SERVICE_` must NOT be preceded by an identifier char, so a token is never
  // spuriously extracted from inside a larger env var NAME (e.g. `DUPLICATI__WEBSERVICE_PASSWORD`
  // must not yield a phantom `SERVICE_PASSWORD`).
  const tokens = [...new Set(text.match(/(?<![A-Z0-9_])SERVICE_[A-Z0-9_]+/g) ?? [])];
  const secrets = new Map<string, Classified & { type: "secret" }>();
  const urls = new Map<string, Classified & { type: "fqdn" | "url" }>();
  for (const tok of tokens) {
    const c = classifyToken(tok);
    if (!c) throw { skip: `unknown-magic:${tok}` };
    if (c.type === "secret") secrets.set(tok, c);
    else urls.set(tok, c);
  }

  text = text
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*)-\s+(SERVICE_[A-Z0-9_]+)\s*$/);
      if (!m) return line;
      const [, indent, tok] = m;
      if (secrets.has(tok)) return `${indent}- ${secrets.get(tok)!.key}=\${${secrets.get(tok)!.key}}`;
      if (urls.has(tok)) return `${indent}- ${urls.get(tok)!.key}=${urlLiteral(urls.get(tok)!, hostPort)}`;
      return line;
    })
    .join("\n");

  for (const tok of [...tokens].sort((a, b) => b.length - a.length)) {
    if (secrets.has(tok)) {
      text = text.split(tok).join(secrets.get(tok)!.key);
    } else {
      const lit = urlLiteral(urls.get(tok)!, hostPort);
      text = text.split(`\${${tok}}`).join(lit).split(tok).join(lit);
    }
  }

  // Only a boundary-delimited SERVICE_ token counts as unresolved — a legit env var name that merely
  // contains "SERVICE_" (e.g. WEBSERVICE_PASSWORD) is fine.
  if (/(?<![A-Z0-9_])SERVICE_[A-Z0-9_]+/.test(text)) throw { skip: "unresolved-magic" };

  const injected = injectPorts(text, hostPort, containerPort);
  text = injected.text;
  if (!new RegExp(`"${hostPort}:`).test(text)) throw { skip: "port-inject-failed" };

  text = declareNamedVolumes(text);

  return {
    compose: text.endsWith("\n") ? text : text + "\n",
    secrets: [...secrets.values()].map(({ key, kind, len }) => ({ key, kind, len })),
    exposure: injected.service
      ? [{ serviceName: injected.service, containerPort, defaultMode: "domain", public: true }]
      : [],
  };
}
