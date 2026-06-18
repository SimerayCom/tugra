/**
 * Pure builders for the shell scripts the agent runs to deploy an app and to
 * run the Traefik reverse-proxy. Supports IMAGE (docker pull) and GIT
 * (clone + Nixpacks/Dockerfile build) sources, optional domain (Traefik + SSL).
 */

export const PROXY_NETWORK = "tugra-proxy";
export const PROXY_NAME = "tugra-proxy";

export type Source = "IMAGE" | "GIT" | "COMPOSE";
export type BuildKind = "NIXPACKS" | "DOCKERFILE";

export interface AppSpec {
  id: string;
  source?: Source;
  image?: string | null;
  gitUrl?: string | null;
  gitBranch?: string | null;
  buildType?: BuildKind;
  dockerfilePath?: string | null;
  composeFile?: string | null;
  healthCmd?: string | null;
  memoryMb?: number | null;
  cpus?: number | null;
  env: Record<string, string>;
  hostPort: number | null;
  containerPort: number | null;
  domain?: string | null;
}

export function containerName(app: { id: string }): string {
  return `tugra_${app.id}`;
}

/**
 * The versioned, locally-stored image tag a deployment runs. Every deploy (GIT
 * build or IMAGE pull) is snapshotted to `tugra_<appId>:<version>` so a later
 * rollback can re-run an old version without rebuilding or re-pulling.
 */
export function runTag(app: { id: string }, version: string): string {
  return `${containerName(app)}:${version}`;
}

/** The upstream image to pull for an IMAGE-source app. */
export function imageRef(app: AppSpec): string {
  return app.image ?? "";
}

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

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

/** Build the prep steps (clone+build, or pull) that produce `tugra_<appId>:<version>`. */
function prepSteps(app: AppSpec, version: string): string[] {
  const tag = runTag(app, version);
  if (app.source === "GIT") {
    const bd = `/etc/tugra/builds/${app.id}`;
    const branch = app.gitBranch || "main";
    const steps = [
      `rm -rf ${bd} && mkdir -p ${bd}`,
      `git clone --depth 1 --branch ${shq(branch)} ${shq(app.gitUrl ?? "")} ${bd}`,
    ];
    if (app.buildType === "DOCKERFILE") {
      const df = app.dockerfilePath || "Dockerfile";
      steps.push(`docker build -t ${tag} -f ${bd}/${df} ${bd}`);
    } else {
      steps.push(
        "command -v nixpacks >/dev/null 2>&1 || curl -sSL https://nixpacks.com/install.sh | bash",
        `nixpacks build ${bd} --name ${tag}`,
      );
    }
    return steps;
  }
  // IMAGE: pull upstream, then snapshot it to the versioned local tag.
  return [
    `docker pull ${shq(imageRef(app))}`,
    `docker tag ${shq(imageRef(app))} ${tag}`,
  ];
}

export const ENV_DIR = "/etc/tugra/env";

export function envFilePath(app: { id: string }): string {
  return `${ENV_DIR}/${app.id}.env`;
}

/** docker --env-file body: one KEY=VALUE per line (values are literal). */
export function envFileContent(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** base64 of the env file, so it can be written on the host without quoting issues. */
export function envFileB64(env: Record<string, string>): string {
  return Buffer.from(envFileContent(env), "utf8").toString("base64");
}

/**
 * Build the deploy script for a specific image version (= deployment id).
 * `build=true` (normal deploy) produces the versioned image first; `build=false`
 * (rollback) skips all prep and just runs the pre-existing versioned tag.
 */
export function buildRunScript(app: AppSpec, version: string, build = true): string {
  const name = containerName(app);
  const ref = runTag(app, version);
  const env = app.env && typeof app.env === "object" ? app.env : {};
  const hasEnv = Object.keys(env).length > 0;
  const envPath = envFilePath(app);

  // Secrets are injected via an --env-file written on the host (0600), not -e,
  // so values never appear in the shell command / process list.
  const envPrelude = hasEnv
    ? [
        `mkdir -p ${ENV_DIR}`,
        `printf %s ${shq(envFileB64(env))} | base64 -d > ${envPath}`,
        `chmod 600 ${envPath}`,
      ]
    : [];
  const envArg = hasEnv ? `--env-file ${envPath}` : "";

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

  // Optional resource limits + container health check.
  const limitArgs: string[] = [];
  if (app.memoryMb) limitArgs.push(`--memory ${app.memoryMb}m`);
  if (app.cpus) limitArgs.push(`--cpus ${app.cpus}`);
  if (app.healthCmd) {
    limitArgs.push(
      `--health-cmd ${shq(app.healthCmd)}`,
      "--health-interval=30s",
      "--health-timeout=5s",
      "--health-retries=3",
      "--health-start-period=10s",
    );
  }

  const runArgs = [
    "docker run -d",
    `--name ${name}`,
    "--restart unless-stopped",
    limitArgs.join(" "),
    envArg,
    netExpose.trim(),
    shq(ref),
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "set -e",
    ...(build ? prepSteps(app, version) : []),
    ...envPrelude,
    `docker rm -f ${name} 2>/dev/null || true`,
    runArgs,
    `docker ps --filter name=${name} --format '{{.Status}}'`,
  ].join("\n");
}

/** Remove a versioned image (used when pruning old rollback points). */
export function buildImageRemoveScript(app: { id: string }, version: string): string {
  return `docker rmi ${runTag(app, version)} 2>/dev/null || true`;
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
