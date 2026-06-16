/**
 * Pure builders for deploying a multi-service app from a docker-compose.yml.
 * The compose file (and an optional .env from the app's secrets) is written on
 * the server from a base64 blob, then `docker compose -p tugra_<appId>` manages
 * the whole stack. The project name namespaces the stack so it can't collide.
 */

import { envFileB64, type AppSpec } from "./deploy-script";

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

export function buildComposeUpScript(app: AppSpec): string {
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
  const envArg = hasEnv ? `--env-file ${envPath} ` : "";
  lines.push(
    `docker compose -p ${proj} -f ${file} ${envArg}up -d --remove-orphans`,
    `docker compose -p ${proj} -f ${file} ps`,
  );
  return lines.join("\n");
}

export function buildComposeStopScript(app: AppSpec): string {
  return `docker compose -p ${composeProject(app)} -f ${composeFilePath(app)} stop`;
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
