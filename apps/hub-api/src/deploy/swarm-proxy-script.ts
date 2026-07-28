/**
 * Pure builders for the swarm-mode Traefik that fronts swarm services (Phase3-B), run on a swarm MANAGER.
 * Unlike the classic per-server Traefik (buildProxySetupScript, one `docker run` per host on a bridge net),
 * this is ONE `docker service` for the whole cluster, pinned to the manager node, on the overlay network,
 * discovering `docker service` labels via Traefik's swarm provider.
 *
 * Design decisions locked in by review:
 *  - `--publish mode=host` (bind 80/443 on the manager only, NOT the routing mesh on every node) → ingress
 *    enters via the manager IP. Combined with `--replicas 1` this is the ONLY safe choice because Traefik's
 *    ACME storage is a local JSON file (multiple replicas would race ACME → Let's Encrypt rate-limits).
 *  - Pinned via a NODE LABEL (not `node.role==manager`) so a future multi-manager can't float the task to a
 *    different node and re-trigger ACME against an empty cert store.
 *  - `--providers.swarm` reads SERVICE labels (`--label` on the app's `docker service`), and we pin
 *    `--providers.swarm.network` so backend discovery is unambiguous. `lbswarm` is deliberately NEVER set
 *    (task-IP mode keeps Traefik's per-task health-check labels effective).
 *  - v1: HTTP-01 (`le`) only. Wildcard DNS-01 (`le-dns`) needs DNS creds, which `docker service create` has
 *    no `--env-file` for → Docker secrets — a follow-up.
 */
import { PROXY_IMAGE } from "./deploy-script";
import { SWARM_OVERLAY, buildOverlayEnsureScript } from "./service-script";

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

export const SWARM_PROXY_NAME = "tugra-swarm-proxy";
export const SWARM_PROXY_NODE_LABEL = "tugra.proxy";
const SWARM_PROXY_CERT_DIR = "/etc/tugra/letsencrypt-swarm";

/** Ensure the overlay network, the manager's proxy node-label, and the swarm-Traefik service exist on the
 *  manager — idempotent, and it NEVER rm+recreates an existing proxy (that would drop ingress for the whole
 *  cluster on every app deploy); an already-present service is left untouched. `managerNodeId` (the swarm
 *  node id captured at formation) pins the service; if absent we fall back to `node.role==manager`. */
export function buildSwarmProxyEnsureScript(opts: { managerNodeId?: string | null; acmeEmail?: string | null }): string {
  const email = opts.acmeEmail || "admin@example.com";
  const pinByLabel = !!opts.managerNodeId;
  const constraint = pinByLabel ? `node.labels.${SWARM_PROXY_NODE_LABEL}==true` : "node.role==manager";

  const createArgs = [
    // --detach so a slow first-create can't block past the WS command timeout (we verify readiness separately).
    `docker service create --detach --name ${SWARM_PROXY_NAME}`,
    `--replicas 1`,
    `--constraint ${shq(constraint)}`,
    // mode=host binds 80/443 on the manager only (not the routing mesh) — single ACME-owning entrypoint.
    `--publish mode=host,target=80,published=80`,
    `--publish mode=host,target=443,published=443`,
    `--network ${shq(SWARM_OVERLAY)}`,
    `--mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,ro`,
    `--mount type=bind,src=${SWARM_PROXY_CERT_DIR},dst=/letsencrypt`,
    PROXY_IMAGE,
    `--providers.swarm=true`,
    `--providers.swarm.exposedByDefault=false`,
    `--providers.swarm.network=${shq(SWARM_OVERLAY)}`,
    `--entrypoints.web.address=:80`,
    `--entrypoints.websecure.address=:443`,
    `--certificatesresolvers.le.acme.email=${shq(email)}`,
    `--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json`,
    `--certificatesresolvers.le.acme.httpchallenge=true`,
    `--certificatesresolvers.le.acme.httpchallenge.entrypoint=web`,
  ].join(" ");

  return [
    "set -e",
    buildOverlayEnsureScript(SWARM_OVERLAY),
    `mkdir -p ${SWARM_PROXY_CERT_DIR} && touch ${SWARM_PROXY_CERT_DIR}/acme.json && chmod 600 ${SWARM_PROXY_CERT_DIR}/acme.json`,
    ...(pinByLabel ? [`docker node update --label-add ${SWARM_PROXY_NODE_LABEL}=true ${shq(opts.managerNodeId!)}`] : []),
    // Idempotent: only create if absent — never rm+recreate a live proxy (whole-cluster ingress outage).
    `if docker service inspect ${SWARM_PROXY_NAME} >/dev/null 2>&1; then echo "swarm proxy exists"; else ${createArgs}; fi`,
  ].join("\n");
}

/** Whether the swarm proxy is up (1/1) — used to verify ensure actually landed a running task (a proxy
 *  scheduled onto a non-manager node would silently discover zero services). */
export function buildSwarmProxyStatusScript(): string {
  return `docker service ls --filter name=${SWARM_PROXY_NAME} --format '{{.Replicas}}'`;
}

/** Detect a CLASSIC per-server Traefik container running on this host — it and the swarm proxy both want
 *  :80/:443, so they must not coexist on the manager (the classic one binds first; the swarm task then
 *  silently crash-loops). Empty output = clear. */
export function buildClassicProxyRunningScript(): string {
  return `docker ps --filter name=^/tugra-proxy$ --format '{{.Names}}'`;
}

/** Tear the swarm proxy down (on dissolve) and CONFIRM it's gone — echoes GONE (removed or never existed)
 *  or STILL (removal failed, e.g. daemon hiccup) so the caller can warn instead of silently leaving an
 *  orphaned proxy bound to :80/:443 on a node that will later look like a free classic-deploy target. */
export function buildSwarmProxyTeardownScript(): string {
  return `docker service rm ${SWARM_PROXY_NAME} >/dev/null 2>&1; if docker service inspect ${SWARM_PROXY_NAME} >/dev/null 2>&1; then echo STILL; else echo GONE; fi`;
}
