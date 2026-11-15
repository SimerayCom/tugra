/**
 * "Does this app's host-bound config fit the target server?" — the pure predicates shared by the app clone
 * (cross-server clone) and the app move preflight, so the two can never disagree about what is host-specific.
 */
import { classifyReadiness, parseStoredInventory } from "../server-ops/gpu-inventory";
import { cpusetMax } from "../applications/dto";

/** A CPU pinning names a core the target does not have. Unknown core count (null) never counts as a misfit. */
export function cpusetExceedsTarget(cpusetCpus: string | null | undefined, targetCpuCores: number | null | undefined): boolean {
  return !!cpusetCpus && targetCpuCores != null && cpusetMax(cpusetCpus) >= targetCpuCores;
}

/** A GPU request while the target is KNOWN to have no usable NVIDIA GPU. An unprobed target (null inventory) is
 *  unknown and never counts; swarm apps are scheduled by the cluster, not pinned to this server. */
export function gpusUnavailableOnTarget(app: { gpus?: string | null; clusterId?: string | null }, targetGpuInventory: unknown): boolean {
  if (!app.gpus || app.clusterId) return false;
  const readiness = classifyReadiness(parseStoredInventory(targetGpuInventory as never));
  return readiness === "none" || readiness === "non_nvidia";
}

/** Stricter than the clone's warning: a move needs the target to be positively READY for the GPU request (anything
 *  else — no GPU, no runtime, driver missing, unprobed — would make the first deploy there fail). */
export function gpuNotReadyOnTarget(app: { gpus?: string | null; clusterId?: string | null }, targetGpuInventory: unknown): boolean {
  if (!app.gpus || app.clusterId) return false;
  return classifyReadiness(parseStoredInventory(targetGpuInventory as never)) !== "ready";
}

/** Host bind mounts point at paths on the SOURCE machine. */
export function hasHostMounts(hostMounts: unknown): boolean {
  return Array.isArray(hostMounts) && hostMounts.length > 0;
}

/** The clone drops owner-granted host-privileged docker options (it never carries a silent escalation). */
export function privilegedOptionsCarried(app: { allowPrivilegedDockerOptions?: boolean | null; dockerOptions?: string | null }): boolean {
  return !!(app.allowPrivilegedDockerOptions && app.dockerOptions);
}

/** A move keeps the SAME app, so the owner-granted privilege flag itself must be consciously dropped (or the move is
 *  refused): true when the flag is set, with or without options currently stored. */
export function hasPrivilegedGrant(app: { allowPrivilegedDockerOptions?: boolean | null }): boolean {
  return !!app.allowPrivilegedDockerOptions;
}
