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

/** Ensure the overlay + node-label + swarm-Traefik service on the manager, reconciled against `confighash`.
 *  With `dns`, adds the `le-dns` DNS-01 resolver + a Docker secret for the provider creds. `secretPrefix`
 *  (tugra-swarm-dns-<clusterId>) scopes secret pruning to this cluster. */
export function buildSwarmProxyEnsureScript(opts: {
  managerNodeId?: string | null;
  acmeEmail?: string | null;
  confighash: string;
  secretPrefix: string;
  dns?: SwarmProxyDns | null;
}): string {
  const email = opts.acmeEmail || "admin@example.com";
  const pinByLabel = !!opts.managerNodeId;
  const constraint = pinByLabel ? `node.labels.${SWARM_PROXY_NODE_LABEL}==true` : "node.role==manager";
  const dns = opts.dns ?? null;

  // Flags passed to Traefik as argv (after `traefik` in the wrapper) — static ones bare, user values shq'd.
  const traefikFlags = [
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
    `--replicas 1`,
    `--constraint ${shq(constraint)}`,
    `--publish mode=host,target=80,published=80`,
    `--publish mode=host,target=443,published=443`,
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
    `mkdir -p ${SWARM_PROXY_CERT_DIR} && touch ${SWARM_PROXY_CERT_DIR}/acme.json && chmod 600 ${SWARM_PROXY_CERT_DIR}/acme.json`,
    ...(dns ? [`touch ${SWARM_PROXY_CERT_DIR}/acme-dns.json && chmod 600 ${SWARM_PROXY_CERT_DIR}/acme-dns.json`] : []),
    ...(pinByLabel ? [`docker node update --label-add ${SWARM_PROXY_NODE_LABEL}=true ${shq(opts.managerNodeId!)}`] : []),
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
