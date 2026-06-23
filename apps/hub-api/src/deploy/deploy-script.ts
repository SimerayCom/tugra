/**
 * Pure builders for the shell scripts the agent runs to deploy an app and to
 * run the Traefik reverse-proxy. Supports IMAGE (docker pull) and GIT
 * (clone + Nixpacks/Dockerfile build) sources, optional domain (Traefik + SSL).
 */

export const PROXY_NETWORK = "tugra-proxy";
export const PROXY_NAME = "tugra-proxy";

export type Source = "IMAGE" | "GIT" | "COMPOSE";
export type BuildKind = "NIXPACKS" | "DOCKERFILE" | "STATIC" | "RAILPACK" | "HEROKU";

export interface AppSpec {
  id: string;
  source?: Source;
  image?: string | null;
  gitUrl?: string | null;
  gitBranch?: string | null;
  buildType?: BuildKind;
  dockerfilePath?: string | null;
  buildCommand?: string | null;
  outputDir?: string | null;
  composeFile?: string | null;
  healthCmd?: string | null;
  memoryMb?: number | null;
  cpus?: number | null;
  volumes?: AppVolume[] | null;
  gitToken?: string | null;
  registryAuth?: RegistryAuth | null;
  env: Record<string, string>;
  hostPort: number | null;
  containerPort: number | null;
  domain?: string | null;
  domainRedirect?: "www" | "root" | null;
  securityHeaders?: boolean;
}

/** Credentials for pulling from a private container registry. */
export interface RegistryAuth {
  url?: string;
  user: string;
  token: string;
}

/** A persistent named volume mounted into the app container. */
export interface AppVolume {
  name: string;
  path: string;
}

export function containerName(app: { id: string }): string {
  return `tugra_${app.id}`;
}

/** Docker volume name for an app's named volume (persists across redeploys). */
export function appVolumeName(app: { id: string }, name: string): string {
  return `tugra_appv_${app.id}_${name}`;
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

function b64(v: string): string {
  return Buffer.from(v, "utf8").toString("base64");
}

/** Inject the `x-access-token` user into an https git URL (token itself stays out). */
export function gitAuthUrl(gitUrl: string): string {
  return gitUrl.replace(/^https:\/\//i, "https://x-access-token@");
}

/**
 * Shell prelude that creates a 0700 temp dir ($sd) for build-time secrets and a
 * single trap to wipe it on exit (success or failure). Reused for git askpass
 * and isolated docker registry config so no token persists on disk.
 */
function secretsDirPrelude(): string[] {
  return [
    "mkdir -p /etc/tugra/builds",
    "sd=$(mktemp -d /etc/tugra/builds/.sec.XXXXXX)",
    'chmod 700 "$sd"',
    `trap 'rm -rf "$sd"' EXIT`,
  ];
}

export function traefikLabels(app: AppSpec): string[] {
  if (!app.domain) return [];
  const r = containerName(app);
  const port = app.containerPort ?? 80;
  const redirect = app.domainRedirect ?? null;
  const base = app.domain.replace(/^www\./i, "");
  const www = `www.${base}`;
  // When a canonical redirect is set, answer for both bare + www hosts.
  const rule = redirect ? `Host(\`${base}\`) || Host(\`${www}\`)` : `Host(\`${app.domain}\`)`;

  const labels = [
    "traefik.enable=true",
    `traefik.http.routers.${r}.rule=${rule}`,
    `traefik.http.routers.${r}.entrypoints=websecure`,
    `traefik.http.routers.${r}.tls.certresolver=le`,
    `traefik.http.services.${r}.loadbalancer.server.port=${port}`,
    `traefik.http.routers.${r}-web.rule=${rule}`,
    `traefik.http.routers.${r}-web.entrypoints=web`,
    `traefik.http.routers.${r}-web.middlewares=${r}-redirect`,
    `traefik.http.middlewares.${r}-redirect.redirectscheme.scheme=https`,
  ];

  const mw: string[] = [];
  if (redirect) {
    const esc = (s: string) => s.replace(/\./g, "\\.");
    const from = redirect === "root" ? www : base; // non-canonical host
    const to = redirect === "root" ? base : www; // canonical host
    labels.push(
      `traefik.http.middlewares.${r}-canon.redirectregex.regex=^https://${esc(from)}/(.*)`,
      `traefik.http.middlewares.${r}-canon.redirectregex.replacement=${"https://" + to + "/${1}"}`,
      `traefik.http.middlewares.${r}-canon.redirectregex.permanent=true`,
    );
    mw.push(`${r}-canon`);
  }
  if (app.securityHeaders) {
    labels.push(
      `traefik.http.middlewares.${r}-sec.headers.stsSeconds=31536000`,
      `traefik.http.middlewares.${r}-sec.headers.stsIncludeSubdomains=true`,
      `traefik.http.middlewares.${r}-sec.headers.contentTypeNosniff=true`,
      `traefik.http.middlewares.${r}-sec.headers.frameDeny=true`,
      `traefik.http.middlewares.${r}-sec.headers.referrerPolicy=strict-origin-when-cross-origin`,
    );
    mw.push(`${r}-sec`);
  }
  if (mw.length) labels.push(`traefik.http.routers.${r}.middlewares=${mw.join(",")}`);
  return labels;
}

/** Generated Dockerfile for a STATIC site: optional node build stage, then nginx. */
export function staticDockerfile(buildCommand?: string | null, outputDir?: string | null): string {
  const out = (outputDir || "dist").replace(/^\/+/, "");
  if (buildCommand) {
    return [
      "FROM node:20-alpine AS build",
      "WORKDIR /app",
      "COPY . .",
      `RUN ${buildCommand}`,
      "FROM nginx:alpine",
      `COPY --from=build /app/${out} /usr/share/nginx/html`,
      "COPY tugra-nginx.conf /etc/nginx/conf.d/default.conf",
    ].join("\n");
  }
  // No build step: the repo already ships the built static files.
  return [
    "FROM nginx:alpine",
    `COPY ${out} /usr/share/nginx/html`,
    "COPY tugra-nginx.conf /etc/nginx/conf.d/default.conf",
  ].join("\n");
}

/** nginx config for a static/SPA site: serve files, fall back to index.html. */
export function staticNginxConf(): string {
  return [
    "server {",
    "  listen 80;",
    "  root /usr/share/nginx/html;",
    "  index index.html;",
    "  location / { try_files $uri $uri/ /index.html; }",
    "}",
  ].join("\n");
}

/** Build the prep steps (clone+build, or pull) that produce `tugra_<appId>:<version>`. */
function prepSteps(app: AppSpec, version: string, noCache = false): string[] {
  const tag = runTag(app, version);
  const nc = noCache ? "--no-cache " : "";
  if (app.source === "GIT") {
    const bd = `/etc/tugra/builds/${app.id}`;
    const branch = app.gitBranch || "main";
    const url = app.gitUrl ?? "";
    const useToken = !!app.gitToken && /^https:\/\//i.test(url);
    const steps = [`rm -rf ${bd} && mkdir -p ${bd}`];
    if (useToken) {
      // Private clone: token via GIT_ASKPASS (never in argv / URL / .git/config).
      steps.push(
        ...secretsDirPrelude(),
        `printf %s ${shq(b64(app.gitToken!))} | base64 -d > "$sd/token"`,
        'chmod 600 "$sd/token"',
        `printf '%s\\n' '#!/bin/sh' 'cat "$(dirname "$0")/token"' > "$sd/askpass"`,
        'chmod 700 "$sd/askpass"',
        `GIT_ASKPASS="$sd/askpass" GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch ${shq(branch)} ${shq(gitAuthUrl(url))} ${bd}`,
      );
    } else {
      steps.push(`git clone --depth 1 --branch ${shq(branch)} ${shq(url)} ${bd}`);
    }
    if (app.buildType === "DOCKERFILE") {
      const df = app.dockerfilePath || "Dockerfile";
      steps.push(`docker build ${nc}-t ${tag} -f ${bd}/${df} ${bd}`);
    } else if (app.buildType === "STATIC") {
      // Generate an nginx (+ optional node build stage) Dockerfile and config.
      steps.push(
        `printf %s ${shq(b64(staticDockerfile(app.buildCommand, app.outputDir)))} | base64 -d > ${bd}/Dockerfile.tugra`,
        `printf %s ${shq(b64(staticNginxConf()))} | base64 -d > ${bd}/tugra-nginx.conf`,
        `docker build ${nc}-t ${tag} -f ${bd}/Dockerfile.tugra ${bd}`,
      );
    } else if (app.buildType === "RAILPACK") {
      // Railpack (Railway's modern builder) — builds an OCI image via BuildKit.
      steps.push(
        "command -v railpack >/dev/null 2>&1 || curl -sSL https://railpack.com/install.sh | sh",
        `railpack build ${bd} --name ${tag}`,
      );
    } else if (app.buildType === "HEROKU") {
      // Heroku / Cloud Native Buildpacks via the pack CLI.
      steps.push(
        "command -v pack >/dev/null 2>&1 || { curl -sSL https://github.com/buildpacks/pack/releases/download/v0.36.0/pack-v0.36.0-linux.tgz | tar -C /usr/local/bin -xz pack; }",
        `pack build ${tag} --path ${bd} --builder heroku/builder:24 --pull-policy if-not-present`,
      );
    } else {
      steps.push(
        "command -v nixpacks >/dev/null 2>&1 || curl -sSL https://nixpacks.com/install.sh | bash",
        `nixpacks build ${bd} --name ${tag}`,
      );
    }
    return steps;
  }
  // IMAGE: pull upstream (optionally authenticating), then snapshot to the tag.
  return [
    ...registryLoginPrelude(app.registryAuth),
    `docker pull ${shq(imageRef(app))}`,
    `docker tag ${shq(imageRef(app))} ${tag}`,
    ...registryLogoutSteps(app.registryAuth),
  ];
}

/** Login to a private registry into an isolated DOCKER_CONFIG ($sd), password via stdin. */
export function registryLoginPrelude(auth?: RegistryAuth | null): string[] {
  if (!auth) return [];
  const host = auth.url ? ` ${shq(auth.url)}` : "";
  return [
    ...secretsDirPrelude(),
    'export DOCKER_CONFIG="$sd"',
    `printf %s ${shq(b64(auth.token))} | base64 -d | docker --config "$sd" login${host} -u ${shq(auth.user)} --password-stdin`,
  ];
}

export function registryLogoutSteps(auth?: RegistryAuth | null): string[] {
  if (!auth) return [];
  const host = auth.url ? ` ${shq(auth.url)}` : "";
  return [`docker --config "$sd" logout${host} || true`];
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
export function buildRunScript(app: AppSpec, version: string, build = true, noCache = false): string {
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

  // Persistent named volumes (data survives redeploys; auto-created by docker).
  const volArgs = (app.volumes ?? [])
    .map((v) => `-v ${appVolumeName(app, v.name)}:${v.path}`)
    .join(" ");

  const runArgs = [
    "docker run -d",
    `--name ${name}`,
    "--restart unless-stopped",
    limitArgs.join(" "),
    envArg,
    netExpose.trim(),
    volArgs,
    shq(ref),
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "set -e",
    ...(build ? prepSteps(app, version, noCache) : []),
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

/** Stop the Traefik proxy container. */
export function buildProxyStopScript(): string {
  return `docker stop ${PROXY_NAME}`;
}

/** Restart the Traefik proxy container. */
export function buildProxyRestartScript(): string {
  return `docker restart ${PROXY_NAME}`;
}

/** Report the proxy container state ("running"/"exited"/… or "absent"). */
export function buildProxyStatusScript(): string {
  return `docker inspect -f '{{.State.Status}}' ${PROXY_NAME} 2>/dev/null || echo absent`;
}

/** Tail the proxy container logs (combined stdout+stderr). */
export function buildProxyLogsScript(tail = 200): string {
  const n = Math.max(1, Math.min(1000, Math.floor(tail)));
  return `docker logs --tail ${n} ${PROXY_NAME} 2>&1`;
}

export function buildStopScript(app: { id: string }): string {
  return `docker stop ${containerName(app)} 2>/dev/null || true`;
}

export function buildRemoveScript(app: { id: string }, volumes: AppVolume[] = []): string {
  // Removing an app destroys its container and its named volumes (intentional).
  return [
    `docker rm -f ${containerName(app)} 2>/dev/null || true`,
    ...volumes.map((v) => `docker volume rm ${appVolumeName(app, v.name)} 2>/dev/null || true`),
  ].join("\n");
}
