/**
 * Pure builders for the shell scripts the agent runs to deploy an app and to
 * run the Traefik reverse-proxy. v1: Docker image → container, optional domain
 * with Traefik + Let's Encrypt (HTTP-01). (Git/Nixpacks build = later.)
 */

export const PROXY_NETWORK = "tugra-proxy";
export const PROXY_NAME = "tugra-proxy";

export interface AppSpec {
  id: string;
  image: string;
  env: Record<string, string>;
  hostPort: number | null;
  containerPort: number | null;
  domain?: string | null;
}

export function containerName(app: { id: string }): string {
  return `tugra_${app.id}`;
}

/** Single-quote a value for safe shell embedding. */
function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Traefik labels that publish the container behind the proxy (empty if no domain). */
export function traefikLabels(app: AppSpec): string[] {
  if (!app.domain) return [];
  const r = containerName(app);
  const port = app.containerPort ?? 80;
  return [
    "traefik.enable=true",
    `traefik.http.routers.${r}.rule=Host(\`${app.domain}\`)`,
    `traefik.http.routers.${r}.entrypoints=websecure`,
    `traefik.http.routers.${r}.tls.certresolver=le`,
    `traefik.http.services.${r}.loadbalancer.server.port=${port}`,
    `traefik.http.routers.${r}-web.rule=Host(\`${app.domain}\`)`,
    `traefik.http.routers.${r}-web.entrypoints=web`,
    `traefik.http.routers.${r}-web.middlewares=${r}-redirect`,
    `traefik.http.middlewares.${r}-redirect.redirectscheme.scheme=https`,
  ];
}

export function buildRunScript(app: AppSpec): string {
  const name = containerName(app);
  const env = app.env && typeof app.env === "object" ? app.env : {};
  const envFlags = Object.entries(env)
    .map(([k, v]) => `-e ${shq(`${k}=${v}`)}`)
    .join(" ");

  let netExpose: string;
  if (app.domain) {
    netExpose =
      `--network ${PROXY_NETWORK} ` +
      traefikLabels(app)
        .map((l) => `--label ${shq(l)}`)
        .join(" ");
  } else {
    netExpose = app.hostPort
      ? `-p ${app.hostPort}:${app.containerPort ?? 80}`
      : "";
  }

  const runArgs = [
    "docker run -d",
    `--name ${name}`,
    "--restart unless-stopped",
    envFlags,
    netExpose.trim(),
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

/** Idempotent setup of the Traefik proxy on a server (Let's Encrypt HTTP-01). */
export function buildProxySetupScript(acmeEmail?: string | null): string {
  const email = acmeEmail || "admin@example.com";
  const runArgs = [
    `docker run -d --name ${PROXY_NAME} --restart unless-stopped`,
    `--network ${PROXY_NETWORK}`,
    "-p 80:80 -p 443:443",
    "-v /var/run/docker.sock:/var/run/docker.sock:ro",
    "-v /etc/tugra/letsencrypt:/letsencrypt",
    "traefik:v3.1",
    "--providers.docker=true",
    "--providers.docker.exposedbydefault=false",
    "--entrypoints.web.address=:80",
    "--entrypoints.websecure.address=:443",
    `--certificatesresolvers.le.acme.email=${shq(email)}`,
    "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json",
    "--certificatesresolvers.le.acme.httpchallenge=true",
    "--certificatesresolvers.le.acme.httpchallenge.entrypoint=web",
  ].join(" ");

  return [
    "set -e",
    `docker network create ${PROXY_NETWORK} 2>/dev/null || true`,
    `docker rm -f ${PROXY_NAME} 2>/dev/null || true`,
    "mkdir -p /etc/tugra/letsencrypt && touch /etc/tugra/letsencrypt/acme.json && chmod 600 /etc/tugra/letsencrypt/acme.json",
    runArgs,
  ].join("\n");
}

export function buildStopScript(app: { id: string }): string {
  return `docker stop ${containerName(app)} 2>/dev/null || true`;
}

export function buildRemoveScript(app: { id: string }): string {
  return `docker rm -f ${containerName(app)} 2>/dev/null || true`;
}
