import type { PatchInfo, UpgradablePackage } from "./types";

/** Packages whose upgrade restarts the container engine (dockerd / containerd / the OCI runtime) — and with it
 *  every container on the host. Exact names: `docker-ce-cli` and friends do not restart anything. */
const RUNTIME_PACKAGES = new Set(["docker-ce", "containerd.io", "runc"]);

export function isContainerRuntimePackage(name: string): boolean {
  return RUNTIME_PACKAGES.has(name);
}

/** Names of the pending updates that will restart every app on the server. Pure. */
export function containerRuntimeUpdates(packages: Pick<UpgradablePackage, "name">[]): string[] {
  return packages.map((p) => p.name).filter(isContainerRuntimePackage);
}

/** Timing of the automatic re-check that follows an update. A mutable object so tests can shrink it. */
export const patchTiming = {
  /** Pause between re-check attempts while the agent is unreachable (e.g. Docker was restarted by the update). */
  intervalMs: 5000,
  /** Give up waiting for the agent after this long. */
  deadlineMs: 180_000,
  /** How long to keep waiting while the host reports the update is still running (it outlives the Docker restart and
   *  the hub's own request; a big upgrade can take a while). */
  runningDeadlineMs: 35 * 60_000,
};

/** Names of the packages dpkg left unfinished, for display. Empty when dpkg is clean. Pure. */
export function interruptedNames(info: Pick<PatchInfo, "dpkgInterrupted">): string[] {
  return info.dpkgInterrupted?.packages.map((p) => p.name) ?? [];
}

/** Is this a transient failure — the agent is gone/restarting, the hub timed out, or the network blipped — as
 *  opposed to a definitive 4xx answer (no permission, bad package)? Duck-typed on `status` so it works for the
 *  web's ApiError and for plain network errors without importing the API client. */
export function isTransientPatchError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return true; // fetch itself failed (network drop, proxy restarting)
  if (status === 0) return true; // the API client's wrapped network failure (ApiError 0, hub_unreachable)
  return status >= 500;
}

/** Proxy/CDN statuses that mean "the upstream never answered" (bad gateway, gateway timeout, Cloudflare 52x) —
 *  the hub's patching endpoints never produce these themselves. */
function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 504 || (status >= 520 && status <= 530);
}

/** The apply request itself failed because the agent dropped (or never answered) mid-run — the typical sign that
 *  the update restarted Docker (and the agent container with it). The hub answers 503 "agent disconnected" /
 *  "…offline" or 504 on a timeout; a 503 for a different reason (host patching unavailable, a patch already
 *  running) is a real failure, not a restart. */
export function isAgentDropError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : "";
  if (typeof status !== "number") return true;
  if (status === 0 || code === "hub_unreachable") return true; // the API client's wrapped network failure / proxy-down answer
  if (isGatewayStatus(status)) return true;
  return status === 503 && /disconnected|offline/i.test(message);
}

export type ApplySummary = {
  /** Packages that were upgradable before the run and are no longer listed. */
  updated: number;
  /** Packages still listed after the run. */
  remaining: number;
};

/** What an update changed, from the pre-apply list and the fresh re-check. A package counts as updated when it
 *  is gone from the new list; one that is still listed (held back, new dependencies, interrupted) stays
 *  remaining. Null when the fresh check cannot be trusted (unsupported or the check itself failed). Pure. */
export function summarizeApply(
  before: Pick<UpgradablePackage, "name">[],
  after: { supported: boolean; checkFailed: boolean; packages: Pick<UpgradablePackage, "name">[]; count: number },
): ApplySummary | null {
  if (!after.supported || after.checkFailed) return null;
  const still = new Set(after.packages.map((p) => p.name));
  const updated = before.filter((p) => !still.has(p.name)).length;
  return { updated, remaining: after.count };
}

/** Text to keep in the log panel once the apply request has settled: the hub's final output when it answered,
 *  otherwise (the agent dropped mid-run) whatever was streamed live, so the log does not vanish exactly when the
 *  Docker restart happens. Pure. */
export function settledApplyLog(response: string | null, streamed: string): string {
  return response && response.length > 0 ? response : streamed;
}

/** Whether to tell the owner "updates applied — reboot required". Only when this run succeeded and really changed
 *  something and the host still wants a reboot: /var/run/reboot-required persists from earlier updates, so after a
 *  failed or no-op run it would contradict the outcome toast (the banner already shows it). Pure. */
export function shouldToastReboot(
  exitCode: number,
  sum: ApplySummary | null,
  after: { supported: boolean; rebootRequired?: boolean },
): boolean {
  return exitCode === 0 && !!sum && sum.updated > 0 && after.supported && !!after.rebootRequired;
}
