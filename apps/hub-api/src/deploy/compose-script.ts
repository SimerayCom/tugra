/**
 * Pure builders for deploying a multi-service app from a docker-compose.yml.
 * The compose file (and an optional .env from the app's secrets) is written on
 * the server from a base64 blob, then `docker compose -p tugra_<appId>` manages
 * the whole stack. The project name namespaces the stack so it can't collide.
 */

import {
  containerName,
  envFileB64,
  registryLoginPrelude,
  registryLogoutSteps,
  traefikLabels,
  PROXY_NETWORK,
  type AppSpec,
} from "./deploy-script";

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
  const labels = traefikLabels(app)
    .map((l) => `      - ${JSON.stringify(l)}`)
    .join("\n");
  return [
    "services:",
    `  ${app.composeWebService}:`,
    "    networks:",
    "      - default",
    `      - ${PROXY_NETWORK}`,
    "    labels:",
    labels,
    "networks:",
    `  ${PROXY_NETWORK}:`,
    "    external: true",
    "",
  ].join("\n");
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

export function buildComposeUpScript(app: AppSpec, noCache = false): string {
  const dir = composeDir(app);
  const file = composeFilePath(app);
  const proj = composeProject(app);
  const env = app.env && typeof app.env === "object" ? app.env : {};
  const hasEnv = Object.keys(env).length > 0;
  const envPath = `${dir}/.env`;
  // Route the web service through Traefik (magic/custom domain) via a label override.
  const magic = !!(app.domain && app.composeWebService);
  const overridePath = composeOverridePath(app);

  const lines = [
    "set -e",
    `mkdir -p ${dir}`,
    `printf %s ${shq(b64(app.composeFile ?? ""))} | base64 -d > ${file}`,
  ];
  if (magic) {
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
  const overrideArg = magic ? `-f ${overridePath} ` : "";
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
