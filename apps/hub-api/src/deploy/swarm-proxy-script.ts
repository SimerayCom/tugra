/**
 * Pure builders for the swarm-mode Traefik that fronts swarm services, run on a swarm MANAGER.
 * Unlike the classic per-server Traefik (buildProxySetupScript, one `docker run` per host on a bridge net),
 * this is ONE `docker service` for the whole cluster, pinned to the manager node, on the overlay network,
 * discovering `docker service` labels via Traefik's swarm provider.
 *
 * Design decisions locked in by review:
 *  - `--publish mode=ingress` (routing mesh: :80/:443 answered on EVERY swarm node, load-balanced by IPVS to
 *    the N task replicas) so ingress survives losing any one node. With `--replicas 1` this behaves
 *    like the old single-node ingress; with 2-3 replicas it is real HA. Each replica keeps its OWN node-local
 *    ACME store (a bind mount) — NOT a shared volume. That is intentional and safe ONLY under DNS-01: the
 *    challenge is an outbound TXT-record API call, so every replica can independently complete its own order
 *    for the same domain with no inbound-request-routing conflict (HTTP-01, which needs the challenge hit to
 *    land on the specific replica holding the order, is fundamentally incompatible with N>1 behind the mesh —
 *    the service layer refuses replicas>1 without le-dns). Replica count is capped at 3 upstream to stay under
 *    Let's Encrypt's 5-duplicate-cert/7-day limit; a rescheduled task re-acquires from scratch (a few-second
 *    self-signed blip on that ONE task while the other N-1 keep serving valid certs via the mesh).
 *  - Pinned via a NODE LABEL (`tugra.proxy==true`, added to every pool node) rather than `node.role==manager`,
 *    so the operator controls exactly which nodes host ingress tasks. (Empty pool → falls back to
 *    `node.role==manager` + forced `--replicas 1`, the safe single-node shape.)
 *  - The `tugra.proxy.confighash` service label folds in the pool (replica count + sorted node ids) so a
 *    replica-count or pool-membership change is detected and takes the rm+recreate branch (a brief blip) —
 *    a plain deploy with an unchanged pool is still skipped (no flap).
 *  - `--providers.swarm` reads SERVICE labels (`--label` on the app's `docker service`), and we pin
 *    `--providers.swarm.network` so backend discovery is unambiguous. `lbswarm` is deliberately NEVER set
 *    (task-IP mode keeps Traefik's per-task health-check labels effective).
 *  - HTTP-01 (`le`) always; DNS-01 wildcard (`le-dns`) when the manager has DNS creds. `docker service
 *    create` has no `--env-file`, so DNS provider creds ride a Docker SECRET mounted at /run/secrets/dns_env;
 *    the container entrypoint is wrapped in `sh -c` to load them into the env before exec'ing Traefik.
 *  - Reconcile via a `tugra.proxy.confighash` service label: unchanged → skip (no ingress flap on deploys),
 *    changed (le-dns toggled / creds rotated / email changed) → rm+recreate (a brief blip, only on a rare
 *    operator config change). Docker secrets are immutable, so a creds change mints a new hash-named secret;
 *    stale ones are pruned.
 */
import { PROXY_IMAGE } from "./deploy-script";
import { SWARM_OVERLAY, buildOverlayEnsureScript } from "./service-script";

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

export const SWARM_PROXY_NAME = "tugra-swarm-proxy";
export const SWARM_PROXY_NODE_LABEL = "tugra.proxy";
export const SWARM_PROXY_CONFIGHASH_LABEL = "tugra.proxy.confighash";
const SWARM_PROXY_CERT_DIR = "/etc/tugra/letsencrypt-swarm";
const DNS_SECRET_MOUNT = "dns_env"; // → /run/secrets/dns_env

// Fixed entrypoint wrapper (no interpolation): loads the DNS-creds secret (if mounted) into the env WITHOUT
// sourcing it as code (a value like `X=$(rm -rf /)` stays inert — same safe read-loop as service-script.ts),
// then exec's Traefik with the flags passed as argv ("$@") — so the flag values never need nested quoting.
const TRAEFIK_WRAPPER =
  `if [ -f /run/secrets/${DNS_SECRET_MOUNT} ]; then set -a; while IFS='=' read -r k v || [ -n "$k" ]; do [ -n "$k" ] && export "$k=$v"; done < /run/secrets/${DNS_SECRET_MOUNT}; set +a; fi; exec traefik "$@"`;

export interface SwarmProxyDns {
  provider: string;
  credsB64: string; // base64 of the KEY=VALUE env body (envFileB64(dnsCreds))
  secretName: string; // tugra-swarm-dns-<clusterId>-<confighash>
}

/** Idempotent per-node prep of the node-local ACME store the swarm Traefik bind-mounts at /letsencrypt:
 *  the dir plus acme.json (and acme-dns.json when DNS-01 is on), chmod 600. A bind mount whose source is
 *  missing makes swarm tasks fail to start on that node, so this MUST run on EVERY ingress pool node before
 *  `docker service create` — the manager gets it inside buildSwarmProxyEnsureScript, the other pool nodes
 *  via a per-node command. */
export function buildSwarmProxyCertDirScript(withDns: boolean): string {
  return [
    `mkdir -p ${SWARM_PROXY_CERT_DIR} && touch ${SWARM_PROXY_CERT_DIR}/acme.json && chmod 600 ${SWARM_PROXY_CERT_DIR}/acme.json`,
    ...(withDns ? [`touch ${SWARM_PROXY_CERT_DIR}/acme-dns.json && chmod 600 ${SWARM_PROXY_CERT_DIR}/acme-dns.json`] : []),
  ].join("\n");
}

/** Ensure the overlay + node-labels + swarm-Traefik service across the ingress pool, reconciled against
 *  `confighash`. `nodeIds` are the docker swarm node ids to label + host ingress tasks (pool, manager first);
 *  `replicas` is the desired task count (routing mesh). Empty `nodeIds` → falls back to `node.role==manager`
 *  with a forced single replica (the safe single-node shape). With `dns`, adds the `le-dns` DNS-01 resolver +
 *  a Docker secret for the provider creds. `secretPrefix` (tugra-swarm-dns-<clusterId>) scopes secret pruning. */
export function buildSwarmProxyEnsureScript(opts: {
  nodeIds: string[];
  replicas: number;
  acmeEmail?: string | null;
  confighash: string;
  secretPrefix: string;
  dns?: SwarmProxyDns | null;
  /** Docker swarm node ids to STRIP the tugra.proxy label from — cluster members that were previously in the
   *  pool but no longer are (a scale-down or a member that dropped). Prevents stale labels from letting the
   *  service schedule a replica onto an unintended node. Safe to pass full ids (docker node update accepts them);
   *  must NOT overlap nodeIds. */
  unlabelNodeIds?: string[];
}): string {
  const email = opts.acmeEmail || "admin@example.com";
  const ids = opts.nodeIds ?? [];
  const unlabel = opts.unlabelNodeIds ?? [];
  const pinByLabel = ids.length > 0;
  const constraint = pinByLabel ? `node.labels.${SWARM_PROXY_NODE_LABEL}==true` : "node.role==manager";
  // The fallback branch (no pool nodes) ignores a bad `replicas` and forces 1, so the builder is self-consistent
  // even if the caller passes something odd for the degenerate empty-pool case.
  const replicas = pinByLabel ? Math.max(1, opts.replicas) : 1;
  const dns = opts.dns ?? null;

  // Flags passed to Traefik as argv (after `traefik` in the wrapper) — static ones bare, user values shq'd.
  const traefikFlags = [
    // Trust-wedge: no phone-home — disable Traefik's upstream version check + anonymous usage report.
    `--global.checknewversion=false`,
    `--global.sendanonymoususage=false`,
    `--providers.swarm=true`,
    `--providers.swarm.exposedByDefault=false`,
    `--providers.swarm.network=${shq(SWARM_OVERLAY)}`,
    `--entrypoints.web.address=:80`,
    `--entrypoints.websecure.address=:443`,
    `--certificatesresolvers.le.acme.email=${shq(email)}`,
    `--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json`,
    `--certificatesresolvers.le.acme.httpchallenge=true`,
    `--certificatesresolvers.le.acme.httpchallenge.entrypoint=web`,
    ...(dns
      ? [
          `--certificatesresolvers.le-dns.acme.email=${shq(email)}`,
          `--certificatesresolvers.le-dns.acme.storage=/letsencrypt/acme-dns.json`,
          `--certificatesresolvers.le-dns.acme.dnschallenge=true`,
          `--certificatesresolvers.le-dns.acme.dnschallenge.provider=${shq(dns.provider)}`,
        ]
      : []),
  ].join(" ");

  const createArgs = [
    `docker service create --detach --name ${SWARM_PROXY_NAME}`,
    `--replicas ${replicas}`,
    `--constraint ${shq(constraint)}`,
    `--publish mode=ingress,target=80,published=80`,
    `--publish mode=ingress,target=443,published=443`,
    `--network ${shq(SWARM_OVERLAY)}`,
    `--mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,ro`,
    `--mount type=bind,src=${SWARM_PROXY_CERT_DIR},dst=/letsencrypt`,
    `--label ${SWARM_PROXY_CONFIGHASH_LABEL}=${shq(opts.confighash)}`,
    ...(dns ? [`--secret source=${shq(dns.secretName)},target=${DNS_SECRET_MOUNT}`] : []),
    `--entrypoint sh`,
    PROXY_IMAGE,
    `-c ${shq(TRAEFIK_WRAPPER)}`,
    `traefik`,
    traefikFlags,
  ].join(" ");

  return [
    "set -e",
    buildOverlayEnsureScript(SWARM_OVERLAY),
    buildSwarmProxyCertDirScript(!!dns),
    // Strip the label from nodes that left the pool FIRST (best-effort), then (re)add it to every current pool
    // node — so after a scale-down the constraint only matches the intended nodes.
    ...unlabel.map((nid) => `docker node update --label-rm ${SWARM_PROXY_NODE_LABEL} ${shq(nid)} >/dev/null 2>&1 || true`),
    ...(pinByLabel ? ids.map((nid) => `docker node update --label-add ${SWARM_PROXY_NODE_LABEL}=true ${shq(nid)}`) : []),
    // Mint the DNS-creds secret (immutable → hash-named; create only if this exact version is absent).
    ...(dns
      ? [`docker secret inspect ${shq(dns.secretName)} >/dev/null 2>&1 || printf %s ${shq(dns.credsB64)} | base64 -d | docker secret create ${shq(dns.secretName)} -`]
      : []),
    // Reconcile: skip if the running proxy already carries this exact confighash (no flap on ordinary
    // deploys); otherwise rm + recreate (a brief blip, only on a real config change).
    `TUGRA_CUR=$(docker service inspect ${SWARM_PROXY_NAME} --format '{{index .Spec.Labels "${SWARM_PROXY_CONFIGHASH_LABEL}"}}' 2>/dev/null || echo "")`,
    `if docker service inspect ${SWARM_PROXY_NAME} >/dev/null 2>&1 && [ "$TUGRA_CUR" = ${shq(opts.confighash)} ]; then echo "swarm proxy up to date"; else docker service rm ${SWARM_PROXY_NAME} >/dev/null 2>&1 || true; ${createArgs}; fi`,
    // Prune this cluster's stale DNS-creds secrets (any hash-name != the desired one; skips in-use ones).
    `for s in $(docker secret ls --filter name=${shq(opts.secretPrefix)} --format '{{.Name}}' 2>/dev/null); do [ "$s" != ${shq(dns?.secretName ?? "")} ] && docker secret rm "$s" >/dev/null 2>&1 || true; done`,
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
 *  orphaned proxy bound to :80/:443 on a node that will later look like a free classic-deploy target. Also
 *  prunes this cluster's DNS-creds secrets (secretPrefix) once the service no longer references them. */
export function buildSwarmProxyTeardownScript(secretPrefix?: string): string {
  const prune = secretPrefix
    ? `; for s in $(docker secret ls --filter name=${shq(secretPrefix)} --format '{{.Name}}' 2>/dev/null); do docker secret rm "$s" >/dev/null 2>&1 || true; done`
    : "";
  return `docker service rm ${SWARM_PROXY_NAME} >/dev/null 2>&1${prune}; if docker service inspect ${SWARM_PROXY_NAME} >/dev/null 2>&1; then echo STILL; else echo GONE; fi`;
}
