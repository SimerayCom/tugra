/**
 * Pure builders for the shell scripts the agent runs to operate the Cloudflare
 * Tunnel connector (`cloudflared`) on a server. The connector runs on the same
 * `tugra-proxy` docker network as Traefik and forwards public ingress to it, so
 * apps behind NAT / without a public IP become reachable (zero-IP expose).
 *
 * Self-contained (own shq/b64) except for PROXY_NETWORK — the whole point is to
 * join Traefik's exact network, so that identifier is single-sourced.
 */
import { PROXY_NETWORK } from "./deploy-script";

export const TUNNEL_CONTAINER_NAME = "tugra-cfd";
export const TUNNEL_ENV_DIR = "/etc/tugra/tunnel";
export const TUNNEL_ENV_PATH = `${TUNNEL_ENV_DIR}/cloudflared.env`;
// TODO(hardening): pin to an @sha256 digest (a wrong pin would break the tunnel),
// mirroring HEALTH_PROBE_IMAGE in deploy-script.ts.
export const DEFAULT_CLOUDFLARED_IMAGE = "cloudflare/cloudflared:2024.10.0";

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}
function b64(v: string): string {
  return Buffer.from(v, "utf8").toString("base64");
}

/**
 * Idempotent start of the cloudflared connector. The connector run-token is
 * written to a 0600 --env-file (`TUNNEL_TOKEN`), never passed as a CLI arg, so it
 * never appears on the host process list / `docker inspect` — the same
 * secret-hygiene rule buildProxySetupScript uses for DNS-01 creds.
 */
export function buildTunnelSetupScript(opts: { token: string; image?: string }): string {
  const image = opts.image || DEFAULT_CLOUDFLARED_IMAGE;
  const envB64 = b64(`TUNNEL_TOKEN=${opts.token}\n`);
  return [
    "set -e",
    `docker network create ${PROXY_NETWORK} 2>/dev/null || true`,
    `docker rm -f ${TUNNEL_CONTAINER_NAME} 2>/dev/null || true`,
    `mkdir -p ${TUNNEL_ENV_DIR}`,
    // base64-transported so the token survives without shell-quoting issues.
    `printf %s ${shq(envB64)} | base64 -d > ${TUNNEL_ENV_PATH}`,
    `chmod 600 ${TUNNEL_ENV_PATH}`,
    `docker run -d --name ${TUNNEL_CONTAINER_NAME} --restart unless-stopped --network ${PROXY_NETWORK} --env-file ${TUNNEL_ENV_PATH} ${image} tunnel --no-autoupdate run`,
  ].join("\n");
}

/** Stop + remove the connector and wipe its token env-file (tolerates absence). */
export function buildTunnelStopScript(): string {
  return [
    `docker rm -f ${TUNNEL_CONTAINER_NAME} 2>/dev/null || true`,
    `rm -f ${TUNNEL_ENV_PATH}`,
  ].join("\n");
}

/** Report the connector container state ("running"/"exited"/… or "absent"). */
export function buildTunnelStatusScript(): string {
  return `docker inspect -f '{{.State.Status}}' ${TUNNEL_CONTAINER_NAME} 2>/dev/null || echo absent`;
}

/** Tail the connector logs (combined stdout+stderr). */
export function buildTunnelLogsScript(tail = 200): string {
  const n = Math.max(1, Math.min(1000, Math.floor(tail)));
  return `docker logs --tail ${n} ${TUNNEL_CONTAINER_NAME} 2>&1 || true`;
}
