// Build-time importer: turns Coolify's Apache-2.0 service-templates.json into
// Tugra's catalog.generated.json and vendors brand icons from dashboard-icons
// (Apache-2.0) into apps/web/public/icons. NOT shipped — run manually:
//   node scripts/import-templates.mjs
// Output (committed): apps/hub-api/src/templates/catalog.generated.json + svgs.
//
// Coolify compose uses its own extensions, so we transform what maps cleanly
// and SKIP the rest (logged). The generated set is gated by catalog.spec.ts.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_JSON = resolve(ROOT, "apps/hub-api/src/templates/catalog.generated.json");
const ICON_DIR = resolve(ROOT, "apps/web/public/icons");

const COOLIFY_INDEX =
  "https://raw.githubusercontent.com/coollabsio/coolify/main/templates/service-templates.json";
const ICON_CDN = (name) =>
  `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${name}.svg`;
const COOLIFY_SVG = (name) =>
  `https://raw.githubusercontent.com/coollabsio/coolify/main/public/svgs/${name}.svg`;

const HOST_PORT_BASE = 20000; // synthesized host ports start here (curated use < 20000)
const DB_IMAGES =
  /(postgres|postgis|pgvector|mysql|mariadb|percona|redis|valkey|keydb|dragonfly|mongo|clickhouse|memcached|rabbitmq|nats|meilisearch|typesense|elasticsearch|opensearch|qdrant|weaviate|minio|etcd|couchdb|influxdb|timescale)/i;

// our TemplateCategory union (kept in sync with catalog.ts)
const CATEGORIES = new Set([
  "cms", "automation", "database", "monitoring", "tools",
  "analytics", "security", "productivity", "developer",
  "ai", "media", "communication", "finance",
]);
const CATEGORY_KEYWORDS = [
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

function mapCategory(coolifyCategory, tags) {
  const hay = `${coolifyCategory ?? ""} ${(tags ?? []).join(" ")}`;
  if (coolifyCategory && CATEGORIES.has(String(coolifyCategory).toLowerCase()))
    return String(coolifyCategory).toLowerCase();
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(hay)) return cat;
  return "tools";
}

// Classify a SERVICE_* magic token → secret descriptor or a url/fqdn literal.
function classifyToken(token) {
  const body = token.replace(/^SERVICE_/, ""); // PASSWORD_64_X, URL_APP, ...
  const lenMatch = body.match(/_(\d{2,3})_/);
  const len = lenMatch ? Number(lenMatch[1]) : undefined;
  const key = body; // env key, no SERVICE_ prefix → no magic token remains
  if (/^FQDN_/.test(body)) return { type: "fqdn", key };
  if (/^URL_/.test(body)) return { type: "url", key };
  if (/^PASSWORDWITHSYMBOLS_/.test(body)) return { type: "secret", key, kind: "password-symbols", len: len ?? 32 };
  if (/^PASSWORD_/.test(body)) return { type: "secret", key, kind: "alnum", len: len ?? 32 };
  if (/^USER_/.test(body)) return { type: "secret", key, kind: "alnum", len: len ?? 16 };
  if (/^REALBASE64_/.test(body)) return { type: "secret", key, kind: "base64", len: len ?? 32 };
  if (/^BASE64_/.test(body)) return { type: "secret", key, kind: "alnum", len: len ?? 32 };
  if (/^HEX_/.test(body)) return { type: "secret", key, kind: "hex", len: len ?? 32 };
  return null; // unknown SERVICE_ token → caller skips template
}

// returns { compose, secrets } or throws { skip: reason }
function transformCompose(rawCompose, hostPort, containerPort) {
  let text = rawCompose;

  // hard skips: Coolify-only / unsupported compose features
  if (/^\s*content:/m.test(text)) throw { skip: "inline-content-mount" };
  if (/^\s*build:/m.test(text)) throw { skip: "build-context" };
  if (/^\s*(include|extends):/m.test(text)) throw { skip: "include/extends" };
  if (/source:\s*\.\.?\//.test(text) || /-\s*\.\.?\/[^\s:]+:/.test(text))
    throw { skip: "relative-bind-mount" };
  if (/^\s*ports:/m.test(text)) throw { skip: "has-own-ports" };

  // strip proxy label blocks (traefik/caddy) — we don't use them
  text = stripBlock(text, /^(\s*)labels:\s*$/m);

  // collect + classify magic tokens
  const tokens = [...new Set(text.match(/SERVICE_[A-Z0-9_]+/g) ?? [])];
  const secrets = new Map();
  const urls = new Map();
  for (const tok of tokens) {
    const c = classifyToken(tok);
    if (!c) throw { skip: `unknown-magic:${tok}` };
    if (c.type === "secret") secrets.set(tok, c);
    else urls.set(tok, c);
  }

  // fix bare env-list injects (`- SERVICE_X`) → `- KEY=<value>`
  text = text
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*)-\s+(SERVICE_[A-Z0-9_]+)\s*$/);
      if (!m) return line;
      const [, indent, tok] = m;
      if (secrets.has(tok)) return `${indent}- ${secrets.get(tok).key}=\${${secrets.get(tok).key}}`;
      if (urls.has(tok)) return `${indent}- ${urls.get(tok).key}=${urlLiteral(urls.get(tok), hostPort)}`;
      return line;
    })
    .join("\n");

  // replace remaining occurrences (longest token first to avoid partial overlap)
  for (const tok of [...tokens].sort((a, b) => b.length - a.length)) {
    if (secrets.has(tok)) {
      text = text.split(tok).join(secrets.get(tok).key); // strips SERVICE_ prefix
    } else {
      const lit = urlLiteral(urls.get(tok), hostPort);
      text = text.split(`\${${tok}}`).join(lit).split(tok).join(lit);
    }
  }

  if (/SERVICE_/.test(text)) throw { skip: "unresolved-magic" };

  // synthesize a published host port on the main (non-db) service
  text = injectPorts(text, hostPort, containerPort);
  if (!new RegExp(`"${hostPort}:`).test(text)) throw { skip: "port-inject-failed" };

  // Coolify omits top-level volume declarations (it injects them) — `docker compose
  // up` errors on undefined named volumes, so declare every referenced named volume.
  text = declareNamedVolumes(text);

  return {
    compose: text.endsWith("\n") ? text : text + "\n",
    secrets: [...secrets.values()].map(({ key, kind, len }) => ({ key, kind, len })),
  };
}

function urlLiteral(c, hostPort) {
  return c.type === "url" ? `http://localhost:${hostPort}` : `localhost:${hostPort}`;
}

// remove an indented block that starts at the matched header line
function stripBlock(text, headerRe) {
  const lines = text.split("\n");
  const out = [];
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

function leadingSpaces(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

// insert `ports: - "<host>:<container>"` under the first non-database service
function injectPorts(text, hostPort, containerPort) {
  const lines = text.split("\n");
  // find services: block
  const svcIdx = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (svcIdx === -1) return text;
  // service entries are the lines indented one level under services:
  const serviceLineRe = /^(\s+)([A-Za-z0-9._-]+):\s*$/;
  // determine child indent of services (first service's indent)
  let svcIndent = null;
  const services = [];
  for (let i = svcIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const ls = leadingSpaces(l);
    if (ls === 0) break; // left the services: block
    const m = l.match(serviceLineRe);
    if (svcIndent === null && m) svcIndent = ls;
    if (m && ls === svcIndent) services.push({ name: m[2], line: i });
  }
  if (svcIndent === null || services.length === 0) return text;
  // pick first service whose image is not a database; default to first
  let target = services[0];
  for (const s of services) {
    const blockEnd = nextServiceStart(lines, s.line, svcIndent);
    const block = lines.slice(s.line, blockEnd).join("\n");
    const img = block.match(/image:\s*["']?([^"'\s]+)/);
    if (!img || !DB_IMAGES.test(img[1])) { target = s; break; }
  }
  const childIndent = " ".repeat(svcIndent + 2);
  const insert = [
    `${childIndent}ports:`,
    `${childIndent}  - "${hostPort}:${containerPort}"`,
  ];
  lines.splice(target.line + 1, 0, ...insert);
  return lines.join("\n");
}

// collect named volumes referenced inside service-level `volumes:` blocks and
// declare any missing ones in a top-level `volumes:` section
function declareNamedVolumes(text) {
  const lines = text.split("\n");
  const referenced = new Set();
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(\s+)volumes:\s*$/); // indented → service-level
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
  // already declared at top level?
  const declared = new Set();
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
  if (topIdx === -1) {
    return text.replace(/\n*$/, "\n") + block.join("\n") + "\n";
  }
  lines.splice(topIdx + 1, 0, ...block);
  return lines.join("\n");
}

function nextServiceStart(lines, from, svcIndent) {
  for (let i = from + 1; i < lines.length; i++) {
    const ls = leadingSpaces(lines[i]);
    if (lines[i].trim() !== "" && ls <= svcIndent) return i;
  }
  return lines.length;
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

async function downloadIcon(slug, coolifyLogo) {
  const candidates = [];
  if (coolifyLogo) {
    const base = String(coolifyLogo).replace(/^svgs\//, "").replace(/\.(svg|png|webp)$/i, "");
    candidates.push(base);
  }
  candidates.push(slug);
  for (const name of [...new Set(candidates)]) {
    for (const url of [ICON_CDN(name), COOLIFY_SVG(name)]) {
      try {
        const r = await fetch(url);
        if (r.ok) {
          const svg = await r.text();
          if (svg.includes("<svg")) {
            await writeFile(resolve(ICON_DIR, `${slug}.svg`), svg, "utf8");
            return true;
          }
        }
      } catch { /* try next */ }
    }
  }
  return false;
}

// curated slugs (catalog.ts) → ensure their icons are vendored too.
// value = dashboard-icons name alias (defaults to the slug when absent)
const CURATED_ICONS = {
  wordpress: "wordpress", ghost: "ghost", n8n: "n8n", "uptime-kuma": "uptime-kuma",
  adminer: "adminer", pocketbase: "pocketbase", gitea: "gitea", directus: "directus",
  umami: "umami", metabase: "metabase", matomo: "matomo", grafana: "grafana",
  vaultwarden: "vaultwarden", minio: "minio", nextcloud: "nextcloud", jellyfin: "jellyfin",
  excalidraw: "excalidraw", mealie: "mealie", wikijs: "wiki-js", "node-red": "node-red",
};

async function main() {
  await mkdir(ICON_DIR, { recursive: true });
  await mkdir(dirname(OUT_JSON), { recursive: true });

  console.log("Vendoring curated icons …");
  let curatedIcons = 0;
  for (const [slug, alias] of Object.entries(CURATED_ICONS)) {
    if (await downloadIcon(slug, `${alias}.svg`)) curatedIcons++;
    else console.log(`  ! no icon for curated ${slug}`);
  }
  console.log(`  vendored ${curatedIcons}/${Object.keys(CURATED_ICONS).length} curated icons`);

  console.log("Fetching Coolify service-templates.json …");
  const index = JSON.parse(await fetchText(COOLIFY_INDEX));
  const entries = Object.entries(index);
  console.log(`Upstream entries: ${entries.length}`);

  const templates = {};
  const skipped = [];
  let port = HOST_PORT_BASE;
  let icons = 0;

  for (const [slug, meta] of entries) {
    try {
      if (!meta?.compose) { skipped.push([slug, "no-compose"]); continue; }
      const raw = Buffer.from(meta.compose, "base64").toString("utf8");
      if (/^#\s*ignore:\s*true/m.test(raw)) { skipped.push([slug, "ignored-upstream"]); continue; }

      const containerPort = Number(meta.port) || firstExpose(raw);
      if (!containerPort) { skipped.push([slug, "no-port"]); continue; }

      const hostPort = port + 1;
      const { compose, secrets } = transformCompose(raw, hostPort, containerPort);
      port = hostPort;

      const hasIcon = await downloadIcon(slug, meta.logo);
      if (hasIcon) icons++;

      templates[slug] = {
        slug,
        name: titleize(slug),
        description: (meta.slogan ?? "").trim() || `${titleize(slug)} self-hosted service.`,
        category: mapCategory(meta.category, meta.tags),
        logo: hasIcon ? slug : undefined,
        secrets,
        composeFile: compose,
      };
    } catch (e) {
      if (e && e.skip) skipped.push([slug, e.skip]);
      else skipped.push([slug, `error:${e?.message ?? e}`]);
    }
  }

  const out = {
    _attribution:
      "Compose templates adapted from Coolify (https://github.com/coollabsio/coolify, Apache-2.0). " +
      "Brand icons from dashboard-icons (https://github.com/homarr-labs/dashboard-icons, Apache-2.0). " +
      "Generated by scripts/import-templates.mjs — do not edit by hand.",
    templates,
  };
  await writeFile(OUT_JSON, JSON.stringify(out, null, 2) + "\n", "utf8");

  // report
  const reasons = {};
  for (const [, r] of skipped) reasons[r.split(":")[0]] = (reasons[r.split(":")[0]] ?? 0) + 1;
  console.log(`\n=== IMPORT REPORT ===`);
  console.log(`Imported: ${Object.keys(templates).length}  ·  Icons vendored: ${icons}`);
  console.log(`Skipped:  ${skipped.length}`);
  for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]))
    console.log(`  - ${r}: ${n}`);
  console.log(`Written: ${OUT_JSON}`);
}

function firstExpose(raw) {
  const m = raw.match(/expose:\s*\n\s*-\s*["']?(\d+)/);
  return m ? Number(m[1]) : 0;
}

function titleize(slug) {
  return slug
    .split(/[-_]/)
    .map((w) => (w.length <= 3 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
