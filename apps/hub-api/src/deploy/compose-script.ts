/**
 * Pure builders for deploying a multi-service app from a docker-compose.yml.
 * The compose file (and an optional .env from the app's secrets) is written on
 * the server from a base64 blob, then `docker compose -p tugra_<appId>` manages
 * the whole stack. The project name namespaces the stack so it can't collide.
 */

import { parse } from "yaml";
import { createHash } from "node:crypto";
import {
  containerName,
  envFileB64,
  registryLoginPrelude,
  registryLogoutSteps,
  traefikLabels,
  PROXY_NETWORK,
  type AppSpec,
} from "./deploy-script";

/** A named volume declared in a compose app's docker-compose.yml. `dockerName` is the real docker
 *  volume: `<project>_<key>` for a normal declaration, the explicit `name:` when set, or the key
 *  itself for `external: true`. `browsable` is true ONLY for Tugra-owned auto-named volumes
 *  (`tugra_<id>_<key>`), so the read-only file browser can never be pointed at an external or
 *  arbitrarily-named host volume. */
export interface ComposeVolume {
  key: string;
  dockerName: string;
  external: boolean;
  browsable: boolean;
  mounts: { service: string; path: string }[];
}

/** Parse the named volumes a COMPOSE app declares (top-level `volumes:` + the service mounts that
 *  reference them). Best-effort + safe: returns [] on a parse error; never throws. Bind mounts
 *  (`./data:/x`, `/host:/x`) are intentionally excluded — only real docker named volumes. */
export function composeVolumes(app: { id: string; composeFile?: string | null }): ComposeVolume[] {
  if (!app.composeFile) return [];
  let doc: unknown;
  try {
    doc = parse(app.composeFile, { merge: true });
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [];
  const topVolumes = (doc as { volumes?: unknown }).volumes;
  if (!topVolumes || typeof topVolumes !== "object" || Array.isArray(topVolumes)) return [];
  const proj = composeProject(app);
  const out = new Map<string, ComposeVolume>();
  for (const [key, def] of Object.entries(topVolumes as Record<string, unknown>)) {
    const d = def && typeof def === "object" && !Array.isArray(def) ? (def as Record<string, unknown>) : {};
    const external = d.external === true || (typeof d.external === "object" && d.external !== null);
    const named = typeof d.name === "string" && d.name ? d.name : undefined;
    const dockerName = named ?? (external ? key : `${proj}_${key}`);
    out.set(key, { key, dockerName, external, browsable: !external && !named && dockerName === `${proj}_${key}`, mounts: [] });
  }
  const services = (doc as { services?: unknown }).services;
  if (services && typeof services === "object" && !Array.isArray(services)) {
    for (const [svc, sdef] of Object.entries(services as Record<string, unknown>)) {
      const vols = (sdef as { volumes?: unknown })?.volumes;
      if (!Array.isArray(vols)) continue;
      for (const v of vols) {
        let src: string | undefined;
        let dst: string | undefined;
        if (typeof v === "string") {
          const parts = v.split(":");
          if (parts.length >= 2) { src = parts[0]; dst = parts[1]; }
        } else if (v && typeof v === "object" && (v as { type?: unknown }).type === "volume") {
          const vv = v as { source?: unknown; target?: unknown };
          if (typeof vv.source === "string") src = vv.source;
          if (typeof vv.target === "string") dst = vv.target;
        }
        if (src && dst && out.has(src)) out.get(src)!.mounts.push({ service: svc, path: dst });
      }
    }
  }
  return [...out.values()];
}

/** Host dir + file path for a materialized config mount (sibling of the compose file, so the app's
 *  `down` `rm -rf` cleans it up). Keyed by mount INDEX to keep the host path Tugra-controlled. */
export function mountsDir(app: { id: string }): string {
  return `${composeDir(app)}/mounts`;
}
export function mountFilePath(app: { id: string }, i: number): string {
  return `${mountsDir(app)}/${i}`;
}

/** An octal file-mode string (3–4 digits), else the default 0644. Guards the value that goes into a
 *  `chmod <mode> <path>` command (so it can never inject a second shell token). */
export function mountMode(mode?: string | null): string {
  return mode && /^0?[0-7]{3,4}$/.test(mode) ? mode : "0644";
}

/** Substitute `${KEY}` in config-file content with the app env value for KEY — closed allowlist (only
 *  keys present in env). `$uri`, `${UNKNOWN}` (no env key), and `$$` are left untouched. Linear scan,
 *  ReDoS-free. This resolves the `${KEY}` placeholders persisted at rest to concrete values at write. */
export function interpolateMountContent(content: string, env: Record<string, string>): string {
  return content.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(env, key) ? env[key] : whole,
  );
}

export const COMPOSE_DIR = "/etc/tugra/compose";

export function composeDir(app: { id: string }): string {
  return `${COMPOSE_DIR}/${app.id}`;
}

export function composeFilePath(app: { id: string }): string {
  return `${composeDir(app)}/docker-compose.yml`;
}

/** Tugra-managed label-only override, layered with a second `-f` (user YAML untouched). */
export function composeOverridePath(app: { id: string }): string {
  return `${composeDir(app)}/docker-compose.tugra.yml`;
}

/**
 * A minimal override compose file that joins the app's primary web service to the
 * Traefik proxy network and stamps it with the router labels — deep-merged over the
 * user's YAML by compose. Reuses traefikLabels() (certType-aware); values are
 * JSON-quoted so backticks/special chars in the Host rule stay valid YAML.
 *
 * The web service is kept on the project `default` network AND joined to the proxy:
 * once a service declares a `networks:` key, compose drops its implicit `default`
 * membership, so we must re-list `default` or the service loses reach to its DB/
 * sibling services (e.g. WordPress → its mariadb).
 */
export function composeOverride(app: AppSpec): string {
  const magic = !!(app.domain && app.composeWebService);
  const mounts = app.configMounts ?? [];
  // Name each service ONCE in the override (duplicate YAML mapping keys are invalid). A service may need
  // networks (the web service), a MERGED `labels:` block (traefik routing for the web service AND a
  // content-fingerprint per mount) and a shared `volumes:` block (all its config-mount binds).
  const order: string[] = [];
  const networks = new Map<string, string[]>();
  const labels = new Map<string, string[]>();
  const binds = new Map<string, string[]>();
  const touch = (name: string) => {
    if (!order.includes(name)) order.push(name);
  };
  const add = (map: Map<string, string[]>, name: string, line: string) => {
    touch(name);
    (map.get(name) ?? map.set(name, []).get(name)!).push(line);
  };

  if (magic && app.composeWebService) {
    // The web service is kept on `default` AND joined to the proxy (declaring `networks:` drops the
    // implicit default membership → it would lose reach to its DB/siblings). Values JSON-quoted.
    const name = app.composeWebService;
    touch(name);
    networks.set(name, ["      - default", `      - ${PROXY_NETWORK}`]);
    for (const l of traefikLabels(app)) add(labels, name, `      - ${JSON.stringify(l)}`);
  }
  mounts.forEach((m, i) => {
    add(binds, m.serviceName, `      - ${JSON.stringify(`${mountFilePath(app, i)}:${m.target}:ro`)}`);
    // Fingerprint label so a content edit changes this service's compose config → `up -d` recreates it.
    add(labels, m.serviceName, `      - ${JSON.stringify(`tugra.config-mount.${i}=${mountFp(m.content)}`)}`);
  });

  const lines: string[] = ["services:"];
  for (const name of order) {
    lines.push(`  ${name}:`);
    const n = networks.get(name);
    if (n && n.length) lines.push("    networks:", ...n);
    const l = labels.get(name);
    if (l && l.length) lines.push("    labels:", ...l); // ONE labels: key (traefik + mount fingerprints)
    const b = binds.get(name);
    if (b && b.length) lines.push("    volumes:", ...b); // ONE volumes: key, all binds appended
  }
  if (magic) lines.push("networks:", `  ${PROXY_NETWORK}:`, "    external: true");
  lines.push("");
  return lines.join("\n");
}

/** Compose project name — namespaces all services of this app. */
export function composeProject(app: { id: string }): string {
  return `tugra_${app.id}`;
}

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** 12-hex content fingerprint, stamped as a per-mount label on its service in the override. It changes
 *  exactly when the stored (placeholder) content changes, so `docker compose up -d` recreates that one
 *  service to load the edited file (a bind whose host path is unchanged would otherwise keep the old
 *  file loaded). Over the placeholder content, never the interpolated one, so a resolved secret never
 *  lands in a docker label. */
function mountFp(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
}

export function buildComposeUpScript(app: AppSpec, noCache = false): string {
  const dir = composeDir(app);
  const file = composeFilePath(app);
  const proj = composeProject(app);
  const env = app.env && typeof app.env === "object" ? app.env : {};
  const hasEnv = Object.keys(env).length > 0;
  const envPath = `${dir}/.env`;
  // Route the web service through Traefik (magic/custom domain) via a label override.
  const magic = !!(app.domain && app.composeWebService);
  const mounts = app.configMounts ?? [];
  const overridePath = composeOverridePath(app);
  // The Tugra override carries the proxy labels AND/OR the config-mount binds — write it for either.
  const writeOverride = magic || mounts.length > 0;

  const lines = [
    "set -e",
    `mkdir -p ${dir}`,
    `printf %s ${shq(b64(app.composeFile ?? ""))} | base64 -d > ${file}`,
  ];
  // Materialize each config file (interpolating ${KEY} from the resolved env) next to the compose, so
  // the override's read-only bind resolves and `down`'s `rm -rf` of the compose dir cleans it up.
  if (mounts.length > 0) {
    lines.push(`mkdir -p ${mountsDir(app)}`);
    mounts.forEach((m, i) => {
      const path = mountFilePath(app, i);
      lines.push(
        `printf %s ${shq(b64(interpolateMountContent(m.content, env)))} | base64 -d > ${path}`,
        `chmod ${mountMode(m.mode)} ${path}`,
      );
    });
  }
  if (writeOverride) {
    lines.push(`printf %s ${shq(b64(composeOverride(app)))} | base64 -d > ${overridePath}`);
  }
  if (hasEnv) {
    lines.push(
      `printf %s ${shq(envFileB64(env))} | base64 -d > ${envPath}`,
      `chmod 600 ${envPath}`,
    );
  }
  // Private registry: log in (isolated config) before pulling, log out after.
  lines.push(...registryLoginPrelude(app.registryAuth));
  const envArg = hasEnv ? `--env-file ${envPath} ` : "";
  const overrideArg = writeOverride ? `-f ${overridePath} ` : "";
  lines.push(
    `docker compose -p ${proj} -f ${file} ${overrideArg}${envArg}up -d ${noCache ? "--pull always " : ""}--remove-orphans`,
    ...registryLogoutSteps(app.registryAuth),
    `docker compose -p ${proj} -f ${file} ${overrideArg}ps`,
  );
  return lines.join("\n");
}

export function buildComposeStopScript(app: AppSpec): string {
  return `docker compose -p ${composeProject(app)} -f ${composeFilePath(app)} stop`;
}

export function buildComposeStartScript(app: AppSpec): string {
  return `docker compose -p ${composeProject(app)} -f ${composeFilePath(app)} start`;
}

export function buildComposeRestartScript(app: AppSpec): string {
  return `docker compose -p ${composeProject(app)} -f ${composeFilePath(app)} restart`;
}

export interface ContainerInfo {
  name: string;
  state: string;
}

/** List the app's containers (compose: all services by project label; else the one). */
export function buildContainersScript(app: AppSpec): string {
  const filter =
    app.source === "COMPOSE"
      ? `--filter label=com.docker.compose.project=${composeProject(app)}`
      : `--filter name=^${containerName(app)}$`;
  return `docker ps -a ${filter} --format '{{.Names}}\t{{.State}}'`;
}

/** Parse `docker ps --format '{{.Names}}\t{{.State}}'` output into a list. */
export function parseContainers(output: string): ContainerInfo[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, state] = l.split("\t");
      return { name: name ?? "", state: state ?? "" };
    })
    .filter((c) => c.name);
}

/** Tail the running container's logs (compose: whole stack; else the app container). */
export function buildLogsScript(app: AppSpec, tail = 200): string {
  const n = Math.max(1, Math.min(2000, Math.floor(tail)));
  if (app.source === "COMPOSE") {
    return `docker compose -p ${composeProject(app)} -f ${composeFilePath(app)} logs --no-color --tail ${n} 2>&1`;
  }
  return `docker logs --tail ${n} ${containerName(app)} 2>&1`;
}

export function buildComposeDownScript(
  app: AppSpec,
  opts: { volumes?: boolean } = {},
): string {
  const vol = opts.volumes ? " -v" : "";
  return [
    `docker compose -p ${composeProject(app)} -f ${composeFilePath(app)} down${vol} 2>/dev/null || true`,
    `rm -rf ${composeDir(app)} 2>/dev/null || true`,
  ].join("\n");
}
