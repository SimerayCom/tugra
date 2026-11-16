import { shq } from "../../../deploy/deploy-script";
import { CUTOVER_HOSTNAME_RE, PROBE_PATH_RE, classifyHealth, type HealthClass } from "../../../cutover/cutover.logic";

/**
 * The DARK probe of a same-host takeover (`swap-proxy`, design 6): while Coolify's proxy still owns :80/:443 of the box,
 * Tugra's own proxy runs with `proxyBind: "none"` (no published port). The existing loopback probe
 * (`curl --resolve host:443:127.0.0.1`) would verify COOLIFY's router there, so this probe targets the Tugra proxy
 * container's own bridge address instead (`curl --resolve host:443:<container ip>`), run by the agent on the host.
 *
 * It prints only status markers, never a response body, so app output can never forge a marker. Two requests per host:
 * one that VERIFIES the certificate (no `-k`: a Traefik default cert or an untrusted one fails verification) and one
 * with `-k` for the HTTP status, so a cert problem and an app problem stay distinguishable. `traefik404` is derived on
 * the host from the first bytes of the body and only the boolean is printed.
 */

const PROXY = "tugra-proxy";
export const DARK_PROBE_MAX_HOSTS = 100;

/** Per-host result of one dark probe. */
export interface DarkHostResult {
  /** curl's `ssl_verify_result`: 0 = verified; null = the probe could not tell (no TLS was attempted or no value). */
  verify: number | null;
  /** HTTP status through the Tugra proxy (-k), null for 000/no answer. */
  status: number | null;
  traefik404: boolean;
}

/** The parsed probe. `no-proxy` = the Tugra proxy container has no address (stopped/absent); `unavailable` = no curl. */
export type DarkProbeResult =
  | { kind: "no-proxy" }
  | { kind: "unavailable" }
  | { kind: "ok"; hosts: Record<string, DarkHostResult> };

export function buildDarkProbeScript(o: { hosts: readonly string[]; path: string }): string {
  if (o.hosts.length === 0 || o.hosts.length > DARK_PROBE_MAX_HOSTS) throw new Error("dark probe: host count out of range");
  for (const h of o.hosts) if (!CUTOVER_HOSTNAME_RE.test(h)) throw new Error("dark probe: invalid hostname");
  if (!PROBE_PATH_RE.test(o.path)) throw new Error("dark probe: invalid path");
  return [
    "set -u",
    `P=${shq(o.path)}`,
    `IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${PROXY} 2>/dev/null | awk '{print $1}')`,
    'case "$IP" in \'\'|*[!0-9.]*) echo "TUGRA_DARK_PROBE_NOPROXY"; exit 0;; esac',
    'command -v curl >/dev/null 2>&1 || { echo "TUGRA_DARK_PROBE_UNAVAILABLE"; exit 0; }',
    'T=$(mktemp) || exit 0',
    `trap 'rm -f "$T"' EXIT`,
    `for H in ${o.hosts.map(shq).join(" ")}; do`,
    `  v=$(curl -sS -o /dev/null -m 8 -w '%{ssl_verify_result}' --resolve "$H:443:$IP" "https://$H/" 2>/dev/null)`,
    `  code=$(curl -ksS -o "$T" -m 8 -w '%{http_code}' --resolve "$H:443:$IP" "https://$H$P" 2>/dev/null)`,
    "  t=0",
    '  [ "$(head -c 18 "$T" 2>/dev/null)" = "404 page not found" ] && t=1',
    `  printf 'TUGRA_DARK_PROBE host=%s verify=%s status=%s traefik404=%s\\n' "$H" "\${v:-x}" "\${code:-000}" "$t"`,
    "done",
    'echo "TUGRA_DARK_PROBE_END"',
  ].join("\n");
}

const LINE_RE = /^TUGRA_DARK_PROBE host=([a-z0-9.-]{1,253}) verify=(\d{1,3}|x) status=(\d{3}) traefik404=([01])$/;

/**
 * Parse the probe output. Fails CLOSED: a cut output (no END marker) or a host that was not asked for is `null`, never
 * a partial pass. Hosts the script did not report are simply absent from `hosts` (the caller treats absence as unknown).
 */
export function parseDarkProbe(out: string, requested: readonly string[]): DarkProbeResult | null {
  if (out.includes("…(truncated)")) return null;
  const lines = out.split(/\r?\n/);
  if (lines.includes("TUGRA_DARK_PROBE_NOPROXY")) return { kind: "no-proxy" };
  if (lines.includes("TUGRA_DARK_PROBE_UNAVAILABLE")) return { kind: "unavailable" };
  if (!lines.includes("TUGRA_DARK_PROBE_END")) return null;
  const want = new Set(requested);
  const hosts: Record<string, DarkHostResult> = {};
  for (const l of lines) {
    const m = LINE_RE.exec(l);
    if (!m || !want.has(m[1])) continue;
    const status = Number(m[3]);
    hosts[m[1]] = { verify: m[2] === "x" ? null : Number(m[2]), status: status === 0 ? null : status, traefik404: m[4] === "1" };
  }
  return { kind: "ok", hosts };
}

/** What one host's dark result means (pure). `ready` = a valid certificate AND the app answers through the Tugra proxy. */
export interface DarkVerdict {
  tls: "ok" | "fail" | "unknown";
  health: HealthClass["kind"] | "unknown";
  ready: boolean;
}

export function classifyDarkHost(r: DarkHostResult | undefined): DarkVerdict {
  if (!r) return { tls: "unknown", health: "unknown", ready: false };
  // No answer at all (000): the connect/handshake never completed, so a verify value of 0 means nothing.
  if (r.status === null) return { tls: r.verify === null ? "unknown" : "fail", health: "unreachable", ready: false };
  const tls: DarkVerdict["tls"] = r.verify === null ? "unknown" : r.verify === 0 ? "ok" : "fail";
  const h = classifyHealth(r.status, r.traefik404);
  return { tls, health: h.kind, ready: tls === "ok" && h.pass };
}
