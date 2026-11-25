/**
 * Create-time checks of a `swap-proxy` run (Coolify hub takeover, lane E). The swap stops the source's own proxy on one machine and
 * starts Tugra's there, so the run's target MUST be that machine, and that machine must not be the one the Coolify control plane runs on.
 * Both are known from the plan before anything is created, so they are refused at create, not at cutover. Pure: names and ids only.
 */

/** One source server of the run (only those with something in scope): is it the control plane box, and which Tugra server is that machine. */
export interface SwapSourceHost {
  ref: string;
  controlPlane: boolean;
  /** The registered Tugra server that is the same machine; null when there is none or the match is not clear. */
  tugraServerId: string | null;
}

export type SwapPlacementVerdict = { ok: true } | { ok: false; code: "swap-control-plane" | "swap-target-not-source-host"; ref: string };

/**
 * `swap-control-plane` first: stopping `coolify-proxy` on the control plane box takes the panel and the API of every managed server away.
 * Then `swap-target-not-source-host`: each source server's target (its entry in the server map, else the run's target) must be the Tugra
 * server that IS that machine. No match is not proof either way, so it is refused too: a swap never starts on a guess.
 */
export function checkSwapPlacement(hosts: readonly SwapSourceHost[], defaultTarget: string, serverMap: Readonly<Record<string, string>>): SwapPlacementVerdict {
  for (const h of hosts) if (h.controlPlane) return { ok: false, code: "swap-control-plane", ref: h.ref };
  for (const h of hosts) {
    const target = serverMap[h.ref] ?? defaultTarget;
    if (!h.tugraServerId || h.tugraServerId !== target) return { ok: false, code: "swap-target-not-source-host", ref: h.ref };
  }
  return { ok: true };
}
