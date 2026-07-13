// Build-time importer: turns Coolify's Apache-2.0 service-templates.json into
// Tugra's catalog.generated.json and vendors brand icons from dashboard-icons
// (Apache-2.0) into apps/web/public/icons. NOT shipped — run manually:
//   pnpm --filter @tugra/hub-api build   # compiles the pure transform lib below
//   node scripts/import-templates.mjs
// Output (committed): apps/hub-api/src/templates/catalog.generated.json + svgs.
//
// The pure compose transforms live in apps/hub-api/src/templates/import-transform.ts (jest-tested,
// type-checked); this script imports their COMPILED output and only does I/O (fetch/base64/write).
// Coolify compose uses its own extensions, so we transform what maps cleanly and SKIP the rest
// (logged). The generated set is gated by catalog.spec.ts. Set COOLIFY_INDEX_FILE to a local copy of
// service-templates.json for a hermetic, offline, deterministic re-run.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_PORT_BASE,
  deriveContainerPort,
  mapCategory,
  titleize,
  transformCompose,
} from "../apps/hub-api/dist/templates/import-transform.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_JSON = resolve(ROOT, "apps/hub-api/src/templates/catalog.generated.json");
const ICON_DIR = resolve(ROOT, "apps/web/public/icons");

const COOLIFY_INDEX =
  "https://raw.githubusercontent.com/coollabsio/coolify/main/templates/service-templates.json";
const ICON_CDN = (name) =>
  `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${name}.svg`;
const COOLIFY_SVG = (name) =>
  `https://raw.githubusercontent.com/coollabsio/coolify/main/public/svgs/${name}.svg`;

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

async function downloadIcon(slug, coolifyLogo) {
  if (existsSync(resolve(ICON_DIR, `${slug}.svg`))) return true; // keep vendored icon, skip re-fetch
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

  const localIndex = process.env.COOLIFY_INDEX_FILE;
  console.log(localIndex ? `Reading local ${localIndex} …` : "Fetching Coolify service-templates.json …");
  const index = JSON.parse(localIndex ? await readFile(localIndex, "utf8") : await fetchText(COOLIFY_INDEX));
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

      // v2: derive the web port from meta.port / a SERVICE_FQDN token / expose / own ports.
      const containerPort = deriveContainerPort(raw, meta.port);
      if (!containerPort) { skipped.push([slug, "no-port"]); continue; }

      const hostPort = port + 1;
      const { compose, secrets, exposure } = transformCompose(raw, hostPort, containerPort);
      port = hostPort;

      const hasIcon = await downloadIcon(slug, meta.logo);
      if (hasIcon) icons++;

      templates[slug] = {
        slug,
        name: titleize(slug),
        description: (meta.slogan ?? "").trim() || `${titleize(slug)} self-hosted service.`,
        category: mapCategory(meta.category, meta.tags),
        logo: hasIcon ? slug : undefined,
        documentation:
          ((meta.documentation ?? "").trim().replace(/[?&]utm_source=[^&]*/g, "").replace(/\?$/, "")) ||
          undefined,
        secrets,
        composeFile: compose,
        ...(exposure && exposure.length ? { exposure } : {}),
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
