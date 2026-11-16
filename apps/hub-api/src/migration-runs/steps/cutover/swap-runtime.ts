import { isAlwaysBlockedIp, isPublicIp } from "../../../common/observed-ip";
import { buildCutoverLoopbackProbeScript } from "../../../cutover/cutover-scripts";
import { classifyHealth, parseCutoverProbeMarkers } from "../../../cutover/cutover.logic";
import type { NetProbe } from "../../../cutover/net-probe";
import type { CutoverWorld, ServerFacts } from "./cutover-world.service";
import {
  buildSwapInspectScript,
  buildSwapReverseScript,
  buildSwapStatusScript,
  buildSwapStopSourceScript,
  parseSwapInspect,
  parseSwapState,
  verifyCoolifyProxyIdentity,
  type CoolifyProxySnapshot,
  type SwapHostState,
} from "./proxy-swap";

/**
 * The swap's host round-trips: one hub-built script through the agent, the output parsed FAIL-CLOSED. Shared by the CUTOVER
 * handler and the plan service so both read the source proxy the same way. Every function returns `null`/`unreadable`
 * for anything it could not read; a caller never treats that as "nothing there".
 */

const T = 60_000;

export type SourceProxy = { ok: true; snapshot: CoolifyProxySnapshot } | { ok: false; code: "unreadable" | "absent" | "name" | "image" | "ports" };

/** Read-only: which container is the source's `coolify-proxy`, and is it really that (name + traefik image + :80/:443)? */
export async function inspectSourceProxy(world: Pick<CutoverWorld, "exec">, serverId: string): Promise<SourceProxy> {
  let out: string;
  try {
    out = (await world.exec(serverId, buildSwapInspectScript(), T)).output;
  } catch {
    return { ok: false, code: "unreadable" };
  }
  const parsed = parseSwapInspect(out);
  if (!parsed) return { ok: false, code: "unreadable" };
  return verifyCoolifyProxyIdentity(parsed);
}

async function state(world: Pick<CutoverWorld, "exec">, serverId: string, script: string): Promise<SwapHostState | null> {
  try {
    return parseSwapState((await world.exec(serverId, script, T)).output);
  } catch {
    return null;
  }
}

/** `docker update --restart=no` then `docker stop` of the recorded id (restart policy first, stop skipped when it fails). */
export const stopSourceProxy = (world: Pick<CutoverWorld, "exec">, serverId: string, containerId: string) => state(world, serverId, buildSwapStopSourceScript(containerId));
/** Stop Tugra's proxy, restore the recorded restart policy, start the recorded source proxy. */
export const reverseSwapOnHost = (world: Pick<CutoverWorld, "exec">, serverId: string, snapshot: Pick<CoolifyProxySnapshot, "containerId" | "restartPolicy">) =>
  state(world, serverId, buildSwapReverseScript(snapshot.containerId, snapshot.restartPolicy));
/** Read-only state of both proxies. */
export const swapHostState = (world: Pick<CutoverWorld, "exec">, serverId: string, containerId: string) => state(world, serverId, buildSwapStatusScript(containerId));

/** Does the Tugra proxy publish host :80 and :443 (it is serving the box's traffic)? */
export function targetPublishesWeb(st: SwapHostState): boolean {
  return st.targetPorts.some((p) => p.startsWith("80>")) && st.targetPorts.some((p) => p.startsWith("443>"));
}

export type SwapVerify = Record<string, { ok: boolean; reason: string }>;

/**
 * After the swap: does each host answer through Tugra's proxy on the box? From the hub straight at the server's public IP
 * (SNI + Host, certificate and health) when the IP is public; else the agent's loopback probe, which is correct from here
 * on because :443 now belongs to Tugra's proxy (its certificate is then unverified: HTTP status only). Any probe trouble
 * is a failed host, never a pass.
 */
export async function verifySwapHosts(deps: { world: Pick<CutoverWorld, "exec">; net: Pick<NetProbe, "sslAt" | "httpAt"> }, facts: ServerFacts, hosts: string[], path: string): Promise<SwapVerify> {
  const out: SwapVerify = {};
  const ip = facts.publicIp;
  const viaHub = !!ip && isPublicIp(ip) && !isAlwaysBlockedIp(ip);
  const one = async (h: string): Promise<void> => {
    try {
      if (viaHub) {
        const ssl = await deps.net.sslAt(ip!, h);
        if (!ssl.ok) {
          out[h] = { ok: false, reason: `cert-${ssl.reason ?? "error"}` };
          return;
        }
        const http = await deps.net.httpAt(ip!, h, { tls: true, path });
        const cls = classifyHealth(http.status, http.traefik404);
        out[h] = { ok: cls.pass, reason: cls.pass ? "ok" : `health-${cls.kind}` };
      } else {
        const r = await deps.world.exec(facts.id, buildCutoverLoopbackProbeScript({ host: h, path }), 30_000);
        const cls = classifyHealth(parseCutoverProbeMarkers(r.output)?.status ?? null, false);
        out[h] = { ok: cls.pass, reason: cls.pass ? "ok" : `health-${cls.kind}` };
      }
    } catch {
      out[h] = { ok: false, reason: "probe-error" };
    }
  };
  for (let i = 0; i < hosts.length; i += 4) await Promise.all(hosts.slice(i, i + 4).map(one));
  return out;
}
