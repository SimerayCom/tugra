/**
 * `docker inspect --format '{{json .}}'` fixtures modelled on the labels of a real Tugra install (the demo host,
 * beta.22): the compose stack, the Traefik proxy, Tugra-run apps/databases/compose services, helper containers and
 * ordinary foreign containers. Only the fields the migrator reads are kept; label sets are verbatim.
 */
const IMG = "ghcr.io/simeraycom/tugra";
const OCI = (title: string) => ({
  "org.opencontainers.image.source": "https://github.com/SimerayCom/tugra",
  "org.opencontainers.image.title": title,
  "org.opencontainers.image.vendor": "Simeray Ltd",
});

function compose(service: string, workingDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "com.docker.compose.container-number": "1",
    "com.docker.compose.oneoff": "False",
    "com.docker.compose.project": "tugra",
    "com.docker.compose.project.config_files": `${workingDir}/docker-compose.yml`,
    "com.docker.compose.project.working_dir": workingDir,
    "com.docker.compose.service": service,
    "com.docker.compose.version": "2.33.0",
    ...extra,
  };
}

export function inspectLine(over: { id?: string; name: string; image: string; labels?: Record<string, string>; state?: string }): string {
  return JSON.stringify({
    Id: over.id ?? `${"a".repeat(12)}${over.name.replace(/[^a-z0-9]/g, "").padEnd(52, "0")}`.slice(0, 64),
    Name: `/${over.name}`,
    State: { Status: over.state ?? "running" },
    Config: { Image: over.image, Env: ["TOKEN=secret"], Labels: over.labels ?? {} },
    HostConfig: { PortBindings: {}, RestartPolicy: { Name: "unless-stopped" } },
    Mounts: [],
  });
}

/** Tugra's own install stack (compose project "tugra"), as on the demo. */
export const STACK = {
  hubApi: inspectLine({ id: "1111111111112222", name: "tugra-hub-api-1", image: `${IMG}-hub:0.1.0-beta.22@sha256:fe7a75238fc3c9282d652fa7f76718a2b4627e615c146177d742f303374e5347`, labels: { ...compose("hub-api", "/repo/deploy"), ...OCI("Tugra Hub API") } }),
  web: inspectLine({ name: "tugra-web-1", image: `${IMG}-web:0.1.0-beta.22@sha256:d5d2fc4a1924945a0a3f79cf6c1ca67d776b58068399888416d0c78a036f4b52`, labels: { ...compose("web", "/repo/deploy", { "com.docker.compose.depends_on": "hub-api:service_started:false" }), ...OCI("Tugra Web") } }),
  agent: inspectLine({ id: "abcdef0123456789aaaa", name: "tugra-agent-1", image: `${IMG}-agent:0.1.0-beta.22`, labels: { ...compose("agent", "/repo/deploy"), ...OCI("Tugra Agent") } }),
  updater: inspectLine({ name: "tugra-tugra-updater-1", image: `${IMG}-updater:0.1.0-beta.22`, labels: { ...compose("tugra-updater", "/root/tugra/deploy"), ...OCI("Tugra Updater") } }),
  // postgres/redis carry NO Tugra name/image/label of their own — only the compose project of the stack.
  postgres: inspectLine({ name: "tugra-postgres-1", image: "postgres:16-alpine@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139", labels: compose("postgres", "/root/tugra/deploy", { "com.docker.compose.version": "5.7.1" }) }),
  redis: inspectLine({ name: "tugra-redis-1", image: "redis:7-alpine@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe", labels: compose("redis", "/root/tugra/deploy", { "com.docker.compose.version": "5.7.1" }) }),
};

/** A stack installed under a custom project + dir whose postgres/redis are only identifiable via the project pass. */
export const CUSTOM_STACK = {
  hub: inspectLine({ name: "panel-hub-api-1", image: `${IMG}-hub:0.1.0`, labels: compose("hub-api", "/srv/panel/deploy", { "com.docker.compose.project": "panel" }) }),
  pg: inspectLine({ name: "panel-postgres-1", image: "postgres:16", labels: compose("postgres", "/srv/panel/deploy", { "com.docker.compose.project": "panel" }) }),
};

export const OTHER_TUGRA = {
  proxy: inspectLine({ name: "tugra-proxy", image: "traefik:v3.7.16@sha256:22a759fb803abb5c3a7ba5d5a55a201c5fb0fc8993d5c72c47a89075e64f1953", labels: { "org.opencontainers.image.title": "Traefik", "tugra.proxy.confighash": "ce12a297cfe3" } }),
  swarmProxy: inspectLine({ name: "tugra-swarm-proxy", image: "traefik:v3.7.16", labels: { "tugra.proxy.confighash": "ce12a297cfe3" } }),
  tunnel: inspectLine({ name: "tugra-cfd", image: "cloudflare/cloudflared:2024.6.1" }),
  // Tugra-run apps / databases / compose services (names + images as on the demo)
  app: inspectLine({ name: "tugra_cmwgxy1zm0j4nnm1a0cfjrm4j", image: "tugra_cmwgxy1zm0j4nnm1a0cfjrm4j:cmwgxy20e0j4tnm1a54gzty93" }),
  db: inspectLine({ name: "tugra_db_cmvqr0re80rcrpc1ac1upamax", image: "redis:7-alpine" }),
  composeSvc: inspectLine({ name: "tugra_cmw8zd2zy1ig7qb1bqjskdu5p-immich-1", image: "ghcr.io/immich-app/immich-server:release", labels: { "com.docker.compose.project": "tugra_cmw8zd2zy1ig7qb1bqjskdu5p", "com.docker.compose.service": "immich" } }),
  // helpers
  vx: inspectLine({ name: "tugra-vx-ab12cd34", image: `${IMG}-agent:0.1.0-beta.22`, labels: { "tugra.role": "volume-stream" } }),
  patch: inspectLine({ name: "tugra-patch", image: `${IMG}-agent:0.1.0-beta.22`, labels: { "tugra.role": "patch-helper" } }),
  reboot: inspectLine({ name: "tugra-reboot-probe", image: `${IMG}-agent:0.1.0-beta.22`, labels: { "tugra.role": "reboot-probe" } }),
  migrator: inspectLine({ name: "tugra-migrator-9f8e", image: `${IMG}-agent:0.1.0-beta.22` }),
  objmig: inspectLine({ name: "tugra-objmig-1a2b", image: "minio/mc:latest" }),
  backup: inspectLine({ name: "tugra_backup_cmw1", image: "postgres:16" }),
  // labelled only (name unremarkable): any tugra.* label means Tugra owns it
  labelled: inspectLine({ name: "scratch-1", image: "alpine:3", labels: { "tugra.role": "gpu-probe" } }),
};

/** Ordinary foreign containers that must keep showing up. */
export const FOREIGN = {
  web: inspectLine({ name: "legacy-web", image: "nginx:1.25" }),
  blog: inspectLine({ name: "my-tugra-blog", image: "wordpress:6" }),
  composeApp: inspectLine({ name: "shop-db-1", image: "postgres:16", labels: compose("db", "/srv/shop", { "com.docker.compose.project": "shop" }) }),
  // a foreign compose app that happens to use the generic service names web/agent, but not Tugra's dir/project
  composeWeb: inspectLine({ name: "shop-web-1", image: "node:22", labels: compose("web", "/srv/shop/deploy", { "com.docker.compose.project": "shop" }) }),
  cloudflared: inspectLine({ name: "my-tunnel", image: "cloudflare/cloudflared:latest" }),
  immichML: inspectLine({ name: "immich_machine_learning", image: "ghcr.io/immich-app/immich-machine-learning:release" }),
};
