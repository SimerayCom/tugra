/**
 * Pure builders for the shell scripts the agent runs to deploy an app and to
 * run the Traefik reverse-proxy. Supports IMAGE (docker pull) and GIT
 * (clone + Nixpacks/Dockerfile build) sources, optional domain (Traefik + SSL).
 */

export const PROXY_NETWORK = "tugra-proxy";
export const PROXY_NAME = "tugra-proxy";

// External health-probe image for the rolling health gate — lets us health-check a
// container over HTTP without baking curl into the app image (works for distroless).
// TODO(hardening): pin to an @sha256 digest (a wrong pin would break every deploy).
export const HEALTH_PROBE_IMAGE = "curlimages/curl:8.11.1";

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
  /** Deploy-gate health check policy. type null = auto (healthCmd→CMD, domain→HTTP, else
   *  NONE); "NONE"|"HTTP"|"CMD" force it. path/port refine an HTTP check. */
  healthCheckType?: string | null;
  healthCheckPath?: string | null;
  healthCheckPort?: number | null;
  memoryMb?: number | null;
  cpus?: number | null;
  volumes?: AppVolume[] | null;
  gitToken?: string | null;
  registryAuth?: RegistryAuth | null;
  env: Record<string, string>;
  /** Build-time variables injected during image build (separate from runtime env). */
  buildArgs?: Record<string, string>;
  /** Raw extra flags appended to `docker run` (advanced; passed through verbatim). */
  dockerOptions?: string | null;
  /** When set, the built image is tagged + pushed to this registry after building. */
  registryPush?: { auth: RegistryAuth; tag: string } | null;
  hostPort: number | null;
  containerPort: number | null;
  domain?: string | null;
  domainRedirect?: "www" | "root" | null;
  securityHeaders?: boolean;
  /** External auth service URL — protects the app via a Traefik forwardauth middleware. */
  forwardAuth?: string | null;
  /** Cert strategy driving the Traefik router: "http"/"none" → plain HTTP; otherwise HTTPS+LE. */
  certType?: string;
  /** Server's wildcard root (e.g. apps.example.com) — for a le-dns wildcard cert. */
  wildcardDomain?: string | null;
  /** Server's custom Traefik resolver name — for certType "custom". */
  customCertResolver?: string | null;
  /** Rolling deploy only: when set, emit a Traefik LB health check on this path so the
   *  unready rollout backend stays out of rotation until it's live (zero-downtime). */
  rollingHealthPath?: string | null;
  /** For a COMPOSE app: the service to attach the Traefik router to (magic domain).
   *  When set, buildComposeUpScript writes a label-only override joining it to the proxy. */
  composeWebService?: string | null;
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

/** Temporary name for the not-yet-live container during a rolling deploy. It carries
 *  the SAME Traefik labels as the canonical container, so both register the identical
 *  router/service (traffic overlaps cleanly) until the old one is removed + rename. */
export function rolloutName(app: { id: string }): string {
  return `${containerName(app)}__rollout`;
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

/** The registry reference the built image is pushed to:
 *  `[<host>/]<namespace>/tugra_<appId>:<version>`. Docker Hub has no host component. The
 *  namespace is the configured imagePrefix, falling back to the username — a bare
 *  `tugra_<id>` would resolve to the unwritable `library/` namespace and the push would be
 *  denied. */
export function registryImageRef(
  reg: { url?: string | null; imagePrefix?: string | null; username?: string | null },
  app: { id: string },
  version: string,
): string {
  const trim = (s: string) => s.replace(/\/+$/, "");
  const host = reg.url ? `${trim(reg.url)}/` : "";
  const ns = reg.imagePrefix ? trim(reg.imagePrefix) : trim(reg.username ?? "");
  const prefix = ns ? `${ns}/` : "";
  return `${host}${prefix}${containerName(app)}:${version}`;
}

/** Tag the locally-built image under the registry ref and push it, reusing the stdin login
 *  (isolated DOCKER_CONFIG, token never in argv) + logout. */
export function buildRegistryPushSteps(localTag: string, pushTag: string, auth: RegistryAuth): string[] {
  return [
    `docker tag ${localTag} ${shq(pushTag)}`,
    ...registryLoginPrelude(auth),
    `docker push ${shq(pushTag)}`,
    ...registryLogoutSteps(auth),
  ];
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
 * Shell prelude that creates a 0700 temp dir ($sd) for build-time secrets. Reused for git
 * askpass and isolated docker registry config so no token persists on disk. When called
 * more than once in a script (e.g. a private git clone AND a registry push), each dir is
 * accumulated into $TUGRA_SEC_DIRS and a single EXIT trap wipes ALL of them — a plain
 * `trap … "$sd"` would be replaced by the second call and orphan the first dir on disk.
 * mktemp paths under /etc/tugra/builds contain no spaces, so the unquoted expansion is safe.
 */
function secretsDirPrelude(): string[] {
  return [
    "mkdir -p /etc/tugra/builds",
    "sd=$(mktemp -d /etc/tugra/builds/.sec.XXXXXX)",
    'chmod 700 "$sd"',
    'TUGRA_SEC_DIRS="${TUGRA_SEC_DIRS:+$TUGRA_SEC_DIRS }$sd"',
    "trap 'rm -rf $TUGRA_SEC_DIRS' EXIT",
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
  // Magic domains (and anything pinned to certType "http"/"none") are served over
  // plain HTTP on the `web` entrypoint — no TLS, no Let's Encrypt, no HTTP→HTTPS
  // redirect. Everything else (custom domains, certType "le-http") keeps the HTTPS
  // router with a cert and the :80→:443 redirect.
  const httpOnly = app.certType === "http" || app.certType === "none";
  const scheme = httpOnly ? "http" : "https";

  // HTTPS cert resolver: DNS-01 wildcard (le-dns), a custom operator resolver, or
  // the default HTTP-01 (le) for le-http / any other HTTPS mode.
  const resolver =
    app.certType === "le-dns" ? "le-dns" : app.certType === "custom" ? app.customCertResolver || "le" : "le";

  const labels = ["traefik.enable=true", `traefik.http.routers.${r}.rule=${rule}`];
  if (httpOnly) {
    labels.push(
      `traefik.http.routers.${r}.entrypoints=web`,
      `traefik.http.services.${r}.loadbalancer.server.port=${port}`,
    );
  } else {
    labels.push(
      `traefik.http.routers.${r}.entrypoints=websecure`,
      `traefik.http.routers.${r}.tls.certresolver=${resolver}`,
      `traefik.http.services.${r}.loadbalancer.server.port=${port}`,
      `traefik.http.routers.${r}-web.rule=${rule}`,
      `traefik.http.routers.${r}-web.entrypoints=web`,
      `traefik.http.routers.${r}-web.middlewares=${r}-redirect`,
      `traefik.http.middlewares.${r}-redirect.redirectscheme.scheme=https`,
    );
    // A DNS-01 wildcard cert covers *.wildcardDomain (+ the apex as a SAN), so every
    // magic app on the server shares one cert instead of one per host.
    if (app.certType === "le-dns" && app.wildcardDomain) {
      labels.push(
        `traefik.http.routers.${r}.tls.domains[0].main=*.${app.wildcardDomain}`,
        `traefik.http.routers.${r}.tls.domains[0].sans=${app.wildcardDomain}`,
      );
    }
  }

  // Rolling deploy only: an active Traefik load-balancer health check so the not-yet-
  // ready rollout backend is kept OUT of rotation until it answers 2xx/3xx on the
  // health path — otherwise Traefik would round-robin live traffic onto a booting
  // container (502s) during the overlap. Set only by buildRollingDeployScript; a
  // hard-cutover deploy never carries it (no behaviour change for existing apps).
  // Assumes the health path returns success; Slice 4 makes the path configurable.
  if (app.rollingHealthPath) {
    labels.push(
      `traefik.http.services.${r}.loadbalancer.healthcheck.path=${app.rollingHealthPath}`,
      `traefik.http.services.${r}.loadbalancer.healthcheck.interval=3s`,
      `traefik.http.services.${r}.loadbalancer.healthcheck.timeout=5s`,
    );
  }

  const mw: string[] = [];
  if (redirect) {
    const esc = (s: string) => s.replace(/\./g, "\\.");
    const from = redirect === "root" ? www : base; // non-canonical host
    const to = redirect === "root" ? base : www; // canonical host
    labels.push(
      `traefik.http.middlewares.${r}-canon.redirectregex.regex=^${scheme}://${esc(from)}/(.*)`,
      `traefik.http.middlewares.${r}-canon.redirectregex.replacement=${scheme + "://" + to + "/${1}"}`,
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
  if (app.forwardAuth) {
    labels.push(
      `traefik.http.middlewares.${r}-fa.forwardauth.address=${app.forwardAuth}`,
      `traefik.http.middlewares.${r}-fa.forwardauth.trustForwardHeader=true`,
      `traefik.http.middlewares.${r}-fa.forwardauth.authResponseHeaders=Remote-User,Remote-Groups,Remote-Name,Remote-Email`,
    );
    mw.unshift(`${r}-fa`); // auth runs first in the chain
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
  // Build-time variables: `--build-arg K=V` for docker build, `--env K=V` for
  // the CNB/nixpacks/railpack builders. Empty → no flags (regression-safe).
  const ba = app.buildArgs && Object.keys(app.buildArgs).length ? app.buildArgs : null;
  const buildArgFlags = ba
    ? Object.entries(ba).map(([k, v]) => `--build-arg ${shq(`${k}=${v}`)}`).join(" ") + " "
    : "";
  const buildEnvFlags = ba
    ? " " + Object.entries(ba).map(([k, v]) => `--env ${shq(`${k}=${v}`)}`).join(" ")
    : "";
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
      steps.push(`docker build ${nc}${buildArgFlags}-t ${tag} -f ${bd}/${df} ${bd}`);
    } else if (app.buildType === "STATIC") {
      // Generate an nginx (+ optional node build stage) Dockerfile and config.
      steps.push(
        `printf %s ${shq(b64(staticDockerfile(app.buildCommand, app.outputDir)))} | base64 -d > ${bd}/Dockerfile.tugra`,
        `printf %s ${shq(b64(staticNginxConf()))} | base64 -d > ${bd}/tugra-nginx.conf`,
        `docker build ${nc}${buildArgFlags}-t ${tag} -f ${bd}/Dockerfile.tugra ${bd}`,
      );
    } else if (app.buildType === "RAILPACK") {
      // Railpack (Railway's modern builder) — builds an OCI image via BuildKit.
      steps.push(
        "command -v railpack >/dev/null 2>&1 || curl -sSL https://railpack.com/install.sh | sh",
        `railpack build ${bd} --name ${tag}${buildEnvFlags}`,
      );
    } else if (app.buildType === "HEROKU") {
      // Heroku / Cloud Native Buildpacks via the pack CLI.
      steps.push(
        "command -v pack >/dev/null 2>&1 || { curl -sSL https://github.com/buildpacks/pack/releases/download/v0.36.0/pack-v0.36.0-linux.tgz | tar -C /usr/local/bin -xz pack; }",
        `pack build ${tag} --path ${bd} --builder heroku/builder:24 --pull-policy if-not-present${buildEnvFlags}`,
      );
    } else {
      // Nixpacks: materialise the build plan first so we can (a) inject curl/wget into the
      // setup phase — a health-cmd like `curl …` must exist inside an otherwise slim image —
      // and (b) pass a per-app --cache-key for fast layer-reuse across deploys. `--env` flags
      // go to BOTH plan and build. jq is best-effort: if it's absent we skip injection (the
      // external HTTP probe still works) rather than install arbitrary packages on the host.
      // The plan lives OUTSIDE bd (a sibling path) so Nixpacks' `COPY . /app` never bakes it
      // into the image; it's removed after the build.
      const plan = `/etc/tugra/builds/${app.id}.plan.json`;
      steps.push(
        "command -v nixpacks >/dev/null 2>&1 || curl -sSL https://nixpacks.com/install.sh | bash",
        `nixpacks plan -f json${buildEnvFlags} ${bd} > ${plan}`,
        "if command -v jq >/dev/null 2>&1; then",
        `  jq '.phases.setup.aptPkgs = ((.phases.setup.aptPkgs // []) + ["curl","wget"] | unique)' ${plan} > ${plan}.tmp && mv ${plan}.tmp ${plan}`,
        "else",
        '  echo "TUGRA: jq not found — skipping curl/wget health-tool injection into the Nixpacks plan" >&2',
        "fi",
        `nixpacks build -c ${plan} --cache-key ${shq(app.id)} --name ${tag}${buildEnvFlags} ${bd}`,
        `rm -f ${plan} ${plan}.tmp`,
      );
    }
    // Push the freshly-built image to the team registry when requested.
    if (app.registryPush) steps.push(...buildRegistryPushSteps(tag, app.registryPush.tag, app.registryPush.auth));
    return steps;
  }
  // IMAGE: pull upstream (optionally authenticating), then snapshot to the tag.
  const imgSteps = [
    ...registryLoginPrelude(app.registryAuth),
    `docker pull ${shq(imageRef(app))}`,
    `docker tag ${shq(imageRef(app))} ${tag}`,
    ...registryLogoutSteps(app.registryAuth),
  ];
  if (app.registryPush) imgSteps.push(...buildRegistryPushSteps(tag, app.registryPush.tag, app.registryPush.auth));
  return imgSteps;
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
/** Write the app's secrets to a 0600 --env-file (empty when there are no env vars).
 *  Secrets go through a file, never -e, so they never hit the process list. */
function envPreludeFor(app: AppSpec): string[] {
  const env = app.env && typeof app.env === "object" ? app.env : {};
  if (Object.keys(env).length === 0) return [];
  const envPath = envFilePath(app);
  return [
    `mkdir -p ${ENV_DIR}`,
    `printf %s ${shq(envFileB64(env))} | base64 -d > ${envPath}`,
    `chmod 600 ${envPath}`,
  ];
}

/** The `docker run -d --name <name> ...` line shared by every deploy strategy —
 *  identical flags (net/labels/env/limits/volumes/image) regardless of the container
 *  name, so a rolling container gets the exact same routing as the canonical one. */
function runContainerArgs(app: AppSpec, version: string, name: string): string {
  const ref = runTag(app, version);
  const env = app.env && typeof app.env === "object" ? app.env : {};
  const envArg = Object.keys(env).length > 0 ? `--env-file ${envFilePath(app)}` : "";

  let netExpose: string;
  if (app.domain) {
    netExpose =
      `--network ${PROXY_NETWORK} ` +
      traefikLabels(app)
        .map((l) => `--label ${shq(l)}`)
        .join(" ");
  } else {
    netExpose = app.hostPort ? `-p ${app.hostPort}:${app.containerPort ?? 80}` : "";
  }

  // Optional resource limits + container health check.
  const limitArgs: string[] = [];
  if (app.memoryMb) limitArgs.push(`--memory ${app.memoryMb}m`);
  if (app.cpus) limitArgs.push(`--cpus ${app.cpus}`);
  if (app.healthCmd) {
    limitArgs.push(
      `--health-cmd ${shq(app.healthCmd)}`,
      // A 10s interval + 30s start period keeps Docker's health status fresh enough for
      // the deploy gate to observe a healthy transition promptly (a 30s interval only
      // yielded ~2 samples inside the gate window) while tolerating a moderately slow boot
      // without a premature "unhealthy". Longer boots are handled by per-app gate config.
      "--health-interval=10s",
      "--health-timeout=5s",
      "--health-retries=3",
      "--health-start-period=30s",
    );
  }

  // Persistent named volumes (data survives redeploys; auto-created by docker).
  const volArgs = (app.volumes ?? [])
    .map((v) => `-v ${appVolumeName(app, v.name)}:${v.path}`)
    .join(" ");

  return [
    "docker run -d",
    `--name ${name}`,
    "--restart unless-stopped",
    limitArgs.join(" "),
    // Operator-supplied raw flags (advanced, passed through verbatim).
    app.dockerOptions?.trim() || "",
    envArg,
    netExpose.trim(),
    volArgs,
    shq(ref),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Hard-cutover deploy: `docker rm -f` the old container, then run the new one under
 * the same stable name. Brief downtime during the swap. Used for non-rolling apps
 * (host-port, risky docker options, named volumes) and rollback (build=false).
 */
export function buildRunScript(app: AppSpec, version: string, build = true, noCache = false): string {
  const name = containerName(app);
  return [
    "set -e",
    ...(build ? prepSteps(app, version, noCache) : []),
    ...envPreludeFor(app),
    `docker rm -f ${name} 2>/dev/null || true`,
    runContainerArgs(app, version, name),
    `docker ps --filter name=${name} --format '{{.Status}}'`,
  ].join("\n");
}

/** How to health-check a container before treating a deploy as live. */
export type HealthProbe =
  | { kind: "native" } // the container has a --health-cmd; poll docker's health status
  | { kind: "httpExternal"; port: number; path: string; onHost?: boolean } // pinned probe container; onHost → host network + localhost (host-port apps), else tugra-proxy + container name
  | { kind: "stableWait" }; // no port/health-cmd → require it to stay Running

/** Timing knobs for the health gate. */
export interface HealthGate {
  retries: number;
  intervalSec: number;
  startPeriodSec: number;
}

/**
 * Pick the deploy-gate probe from the app's health-check config. `healthCheckType`:
 * null = auto (a container health-cmd → native; a routed OR host-port app → HTTP; else a
 * liveness wait); "CMD"/"HTTP"/"NONE" force it. An HTTP check reaches a routed app by its
 * container name over tugra-proxy, or a host-port app via localhost on the host network;
 * with neither reachable it degrades to a liveness wait.
 */
export function resolveHealthProbe(app: AppSpec): HealthProbe {
  const type = app.healthCheckType ?? (app.healthCmd ? "CMD" : app.domain ? "HTTP" : "NONE");
  if (type === "CMD") return { kind: "native" };
  if (type === "HTTP") {
    const path = app.healthCheckPath || "/";
    // Routed app: probe its own container on the proxy network (a custom port still only
    // reaches this app's container). Host-port app: probe localhost over the host network —
    // pinned to the app's OWN published port, never an arbitrary one, so it can't be turned
    // into a host-wide localhost port scanner.
    if (app.domain) return { kind: "httpExternal", port: app.healthCheckPort ?? app.containerPort ?? 80, path };
    if (app.hostPort) return { kind: "httpExternal", port: app.hostPort, path, onHost: true };
    return { kind: "stableWait" }; // HTTP configured but no reachable endpoint
  }
  return { kind: "stableWait" }; // NONE
}

/**
 * Shell fragment (runs under `set +e`) that sets `healthy=1` iff the target container
 * passes its probe within the bounded window, else leaves it 0. Guards every probe
 * with `if` so a failed check never aborts the surrounding script.
 */
export function buildHealthGateFragment(target: string, probe: HealthProbe, t: HealthGate): string[] {
  const lines = ["healthy=0", `sleep ${t.startPeriodSec}`];
  if (probe.kind === "native") {
    lines.push(
      `for i in $(seq 1 ${t.retries}); do`,
      `  st=$(docker inspect --format '{{json .State.Health.Status}}' ${target} 2>/dev/null || echo '""')`,
      `  if [ "$st" = '"healthy"' ]; then healthy=1; break; fi`,
      `  if [ "$st" = '"unhealthy"' ]; then break; fi`, // fail fast
      `  sleep ${t.intervalSec}`,
      "done",
    );
  } else if (probe.kind === "httpExternal") {
    // Reach a routed app by its container name over the proxy network; reach a host-port
    // app via localhost on the host network (onHost). "Reachable and serving" = any HTTP
    // response below 500: a booted app commonly answers the probe path with 404 (API root),
    // 401/403 (auth-gated), or 400 (a strict Host allow-list rejecting the container-name
    // Host header) — those must NOT fail the gate. Only a refused/timed-out connection
    // (curl → "000") or a 5xx counts as unhealthy.
    const net = probe.onHost ? "host" : PROXY_NETWORK;
    const host = probe.onHost ? "localhost" : target;
    // Single-quote the URL so the probe path can never break out of the docker-run word
    // even if the path validation is ever loosened (defence-in-depth).
    const url = shq(`http://${host}:${probe.port}${probe.path}`);
    lines.push(
      `for i in $(seq 1 ${t.retries}); do`,
      `  code=$(docker run --rm --network ${net} ${HEALTH_PROBE_IMAGE} -s -o /dev/null -w '%{http_code}' --max-time 5 ${url} 2>/dev/null || echo 000)`,
      `  if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then healthy=1; break; fi`,
      `  sleep ${t.intervalSec}`,
      "done",
    );
  } else {
    // stableWait: already slept the start period; require the container still Running.
    lines.push(`if [ "$(docker inspect --format '{{.State.Running}}' ${target} 2>/dev/null)" = "true" ]; then healthy=1; fi`);
  }
  return lines;
}

/**
 * Zero-downtime rolling deploy for a routed (domain) app. Builds the new image, starts
 * it under a temporary name carrying the SAME Traefik labels (so both versions serve
 * during the overlap), health-gates it, then on success removes the old container and
 * renames the new one into place (exit 0); on failure removes the new container and
 * leaves the old one serving untouched (exit 3 — auto-rollback, zero downtime).
 */
export function buildRollingDeployScript(
  app: AppSpec,
  version: string,
  opts: { build?: boolean; noCache?: boolean; probe: HealthProbe } & HealthGate,
): string {
  const canonical = containerName(app);
  const rollout = rolloutName(app);
  const build = opts.build ?? true;
  // Give the rollout a Traefik LB health check so it stays out of rotation until ready
  // (only meaningful for a routed app; the external probe already gates the cutover).
  const hcPath = opts.probe.kind === "httpExternal" ? opts.probe.path : "/";
  const rApp: AppSpec = { ...app, rollingHealthPath: app.domain ? hcPath : null };
  return [
    "set -e",
    ...(build ? prepSteps(app, version, opts.noCache ?? false) : []),
    ...envPreludeFor(app),
    `docker rm -f ${rollout} 2>/dev/null || true`, // clear any stale rollout
    runContainerArgs(rApp, version, rollout),
    "set +e", // the health gate must not abort the script on a failed probe
    ...buildHealthGateFragment(rollout, opts.probe, opts),
    `if [ "$healthy" = 1 ]; then`,
    `  docker rm -f ${canonical} 2>/dev/null || true`,
    // Gate success on the rename actually landing — otherwise the live container keeps
    // the temp name and every lifecycle command (stop/start/logs) would miss it.
    `  if docker rename ${rollout} ${canonical}; then echo "TUGRA_ROLLOUT: healthy"; exit 0; else echo "TUGRA_ROLLOUT: rename_failed"; exit 1; fi`,
    "else",
    `  docker rm -f ${rollout} 2>/dev/null || true`, // old container stays; zero downtime
    `  echo "TUGRA_ROLLOUT: rolled_back"; exit 3`,
    "fi",
  ].join("\n");
}

/**
 * Recreate deploy with a health gate + auto-rollback for apps that CANNOT run two
 * containers at once (host-port, custom `--network`/`--name`/`-p`, named volumes, or an
 * explicit RECREATE strategy). Builds the new image, stops the old container, starts the
 * new one under the SAME canonical name, then health-gates it. On success exit 0. On
 * failure it removes the unhealthy new container and — if a previous good image exists —
 * re-runs that image under the canonical name (exit 3, app back on the previous version);
 * with no previous version, or if the rollback re-run itself fails, it exits non-zero so
 * the app is honestly reported FAILED (never a false "kept the previous version").
 *
 * Unlike rolling this has a brief downtime window (old removed before new is gated), which
 * is unavoidable when a temporary overlapping container is impossible.
 */
export function buildRecreateDeployScript(
  app: AppSpec,
  version: string,
  opts: { build?: boolean; noCache?: boolean; prevVersion?: string | null; probe: HealthProbe } & HealthGate,
): string {
  const canonical = containerName(app);
  const build = opts.build ?? true;
  // prevVersion is the previous successful deployment id → its retained image is
  // runTag(app, prevVersion). Re-run it (no rebuild) to restore service.
  const rollback = opts.prevVersion
    ? `  if ${runContainerArgs(app, opts.prevVersion, canonical)}; then echo "TUGRA_ROLLOUT: rolled_back"; exit 3; else echo "TUGRA_ROLLOUT: rollback_failed"; exit 1; fi`
    : `  echo "TUGRA_ROLLOUT: failed"; exit 1`;
  return [
    "set -e",
    ...(build ? prepSteps(app, version, opts.noCache ?? false) : []),
    ...envPreludeFor(app),
    `docker rm -f ${canonical} 2>/dev/null || true`, // stop old (brief downtime begins)
    "set +e", // from here a start/health failure must reach the rollback branch, not abort
    // Guard the start itself: a `docker run` rejected by the daemon (port clash, bad mount,
    // invalid flag, memory below Docker's minimum) must fall through to rollback — under a
    // bare `set -e` it would abort the script and leave the app down with the old container
    // already removed and the previous image never restored.
    `if ${runContainerArgs(app, version, canonical)}; then`,
    ...buildHealthGateFragment(canonical, opts.probe, opts).map((l) => "  " + l),
    "else",
    "  healthy=0", // new container failed to even start → treat as unhealthy
    "fi",
    `if [ "$healthy" = 1 ]; then`,
    `  echo "TUGRA_ROLLOUT: healthy"; exit 0`,
    "else",
    `  docker rm -f ${canonical} 2>/dev/null || true`, // drop the unhealthy/failed new container
    rollback,
    "fi",
  ].join("\n");
}

/** Remove a versioned image (used when pruning old rollback points). */
export function buildImageRemoveScript(app: { id: string }, version: string): string {
  return `docker rmi ${runTag(app, version)} 2>/dev/null || true`;
}

export const PROXY_DNS_ENV_DIR = "/etc/tugra/proxy";
export const PROXY_DNS_ENV_PATH = `${PROXY_DNS_ENV_DIR}/dns.env`;

/**
 * Idempotent setup of the Traefik proxy on a server: always a Let's Encrypt HTTP-01
 * resolver `le`, and — when the server has DNS-01 creds — a second `le-dns` resolver
 * for wildcard certificates. The DNS provider credentials are written to a 0600
 * --env-file (never `-e`/argv), so they never appear on the process list.
 */
export function buildProxySetupScript(
  opts: { acmeEmail?: string | null; dnsProvider?: string | null; dnsCreds?: Record<string, string> | null } = {},
): string {
  const email = opts.acmeEmail || "admin@example.com";
  const dns =
    opts.dnsProvider && opts.dnsCreds && Object.keys(opts.dnsCreds).length > 0
      ? { provider: opts.dnsProvider, creds: opts.dnsCreds }
      : null;

  const runArgs = [
    `docker run -d --name ${PROXY_NAME} --restart unless-stopped`,
    `--network ${PROXY_NETWORK}`,
    "-p 80:80 -p 443:443",
    "-v /var/run/docker.sock:/var/run/docker.sock:ro",
    "-v /etc/tugra/letsencrypt:/letsencrypt",
    // DNS creds via a 0600 env-file, never -e — kept off the process list / docker inspect.
    ...(dns ? [`--env-file ${PROXY_DNS_ENV_PATH}`] : []),
    "traefik:v3.1",
    "--providers.docker=true",
    "--providers.docker.exposedbydefault=false",
    "--entrypoints.web.address=:80",
    "--entrypoints.websecure.address=:443",
    `--certificatesresolvers.le.acme.email=${shq(email)}`,
    "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json",
    "--certificatesresolvers.le.acme.httpchallenge=true",
    "--certificatesresolvers.le.acme.httpchallenge.entrypoint=web",
    // Wildcard cert via DNS-01 — separate ACME storage from the HTTP-01 resolver.
    ...(dns
      ? [
          `--certificatesresolvers.le-dns.acme.email=${shq(email)}`,
          "--certificatesresolvers.le-dns.acme.storage=/letsencrypt/acme-dns.json",
          "--certificatesresolvers.le-dns.acme.dnschallenge=true",
          `--certificatesresolvers.le-dns.acme.dnschallenge.provider=${shq(dns.provider)}`,
        ]
      : []),
  ].join(" ");

  return [
    "set -e",
    `docker network create ${PROXY_NETWORK} 2>/dev/null || true`,
    `docker rm -f ${PROXY_NAME} 2>/dev/null || true`,
    "mkdir -p /etc/tugra/letsencrypt && touch /etc/tugra/letsencrypt/acme.json && chmod 600 /etc/tugra/letsencrypt/acme.json",
    ...(dns
      ? [
          "touch /etc/tugra/letsencrypt/acme-dns.json && chmod 600 /etc/tugra/letsencrypt/acme-dns.json",
          `mkdir -p ${PROXY_DNS_ENV_DIR}`,
          `printf %s ${shq(envFileB64(dns.creds))} | base64 -d > ${PROXY_DNS_ENV_PATH}`,
          `chmod 600 ${PROXY_DNS_ENV_PATH}`,
        ]
      : []),
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

/** Start a stopped app container (no rebuild). */
export function buildStartScript(app: { id: string }): string {
  return `docker start ${containerName(app)}`;
}

/** Restart the app container (no rebuild). */
export function buildRestartScript(app: { id: string }): string {
  return `docker restart ${containerName(app)}`;
}

export function buildRemoveScript(app: { id: string }, volumes: AppVolume[] = []): string {
  // Removing an app destroys its container and its named volumes (intentional).
  return [
    `docker rm -f ${containerName(app)} 2>/dev/null || true`,
    ...volumes.map((v) => `docker volume rm ${appVolumeName(app, v.name)} 2>/dev/null || true`),
  ].join("\n");
}
