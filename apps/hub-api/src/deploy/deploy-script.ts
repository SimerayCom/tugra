/**
 * Pure builders for the shell scripts the agent runs to deploy an app.
 * v1 = Docker image → container. (Git/Nixpacks build + Traefik/SSL = later.)
 */

export interface AppSpec {
  id: string;
  image: string;
  env: Record<string, string>;
  hostPort: number | null;
  containerPort: number | null;
}

export function containerName(app: { id: string }): string {
  return `tugra_${app.id}`;
}

/** Single-quote a value for safe shell embedding. */
function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

export function buildRunScript(app: AppSpec): string {
  const name = containerName(app);
  const env = app.env && typeof app.env === "object" ? app.env : {};
  const envFlags = Object.entries(env)
    .map(([k, v]) => `-e ${shq(`${k}=${v}`)}`)
    .join(" ");
  const portFlag = app.hostPort
    ? `-p ${app.hostPort}:${app.containerPort ?? 80}`
    : "";
  const runArgs = [
    "docker run -d",
    `--name ${name}`,
    "--restart unless-stopped",
    envFlags,
    portFlag,
    shq(app.image),
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "set -e",
    `docker pull ${shq(app.image)}`,
    `docker rm -f ${name} 2>/dev/null || true`,
    runArgs,
    `docker ps --filter name=${name} --format '{{.Status}}'`,
  ].join("\n");
}

export function buildStopScript(app: { id: string }): string {
  return `docker stop ${containerName(app)} 2>/dev/null || true`;
}

export function buildRemoveScript(app: { id: string }): string {
  return `docker rm -f ${containerName(app)} 2>/dev/null || true`;
}
