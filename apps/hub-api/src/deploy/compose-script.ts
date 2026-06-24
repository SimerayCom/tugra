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
  type AppSpec,
} from "./deploy-script";

export const COMPOSE_DIR = "/etc/tugra/compose";

export function composeDir(app: { id: string }): string {
  return `${COMPOSE_DIR}/${app.id}`;
}

export function composeFilePath(app: { id: string }): string {
  return `${composeDir(app)}/docker-compose.yml`;
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

  const lines = [
    "set -e",
    `mkdir -p ${dir}`,
    `printf %s ${shq(b64(app.composeFile ?? ""))} | base64 -d > ${file}`,
  ];
  if (hasEnv) {
    lines.push(
      `printf %s ${shq(envFileB64(env))} | base64 -d > ${envPath}`,
      `chmod 600 ${envPath}`,
    );
  }
  // Private registry: log in (isolated config) before pulling, log out after.
  lines.push(...registryLoginPrelude(app.registryAuth));
  const envArg = hasEnv ? `--env-file ${envPath} ` : "";
  lines.push(
    `docker compose -p ${proj} -f ${file} ${envArg}up -d ${noCache ? "--pull always " : ""}--remove-orphans`,
    ...registryLogoutSteps(app.registryAuth),
    `docker compose -p ${proj} -f ${file} ps`,
  );
  return lines.join("\n");
}

export function buildComposeStopScript(app: AppSpec): string {
  return `docker compose -p ${composeProject(app)} -f ${composeFilePath(app)} stop`;
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
