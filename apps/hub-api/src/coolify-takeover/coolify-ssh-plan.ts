import { ForbiddenException } from "@nestjs/common";
import {
  COOLIFY_SSH_LIMITS,
  type CoolifyProbeFacts,
  type CoolifySshResultCode,
  type CoolifySshResultMsg,
  type CoolifySshTargetState,
} from "@tugra/shared";
import { AgentCommandTimeoutException, AgentDisconnectedException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { isPublicAddress, normalizeAddress } from "./coolify-install-plan";

/** Pure decisions of the SSH install (Coolify hub takeover, lane C). Nothing here touches the network, the database or the clock. */

/** States in which something is, or is about to be, working on a target: a run is not finished while one of these is present. */
export const COOLIFY_SSH_ACTIVE_STATES: readonly CoolifySshTargetState[] = ["PLANNED", "PROBING", "TOKEN_MINTED", "INSTALLING", "WAIT_ENROLL", "UNINSTALLING"];

/** A hub that can tell the host key fingerprint a freshly enrolled agent reports about its own machine (lane D adds the report). */
export const COOLIFY_HOST_IDENTITY = "COOLIFY_HOST_IDENTITY";
export interface CoolifyHostIdentityReader {
  reportedHostKeyFp(serverId: string): Promise<string | null>;
}

export function isActiveState(s: string): boolean {
  return (COOLIFY_SSH_ACTIVE_STATES as readonly string[]).includes(s);
}

/** The per-host concurrency the owner asked for, kept inside 1..max. */
export function clampPerHost(n: number | undefined): number {
  const v = Number.isInteger(n) ? (n as number) : COOLIFY_SSH_LIMITS.perHostDefault;
  return Math.max(1, Math.min(COOLIFY_SSH_LIMITS.perHostMax, v));
}

/** What a probe result means for the target. A server that already runs an agent is left alone, never a failure. */
export function decideProbe(res: Pick<CoolifySshResultMsg, "ok" | "code" | "probe">): { state: CoolifySshTargetState; code: CoolifySshResultCode | null } {
  if (res.ok && res.code === "skipped_present") return { state: "SKIPPED_PRESENT", code: "skipped_present" };
  if (res.ok && res.code === "skipped_foreign") return { state: "SKIPPED_FOREIGN", code: "skipped_foreign" };
  if (res.ok) return { state: "READY", code: null };
  return { state: "FAILED", code: res.code };
}

/** Install under `sudo -n` when the user is not root and has no Docker access of its own. Unknown facts mean "not root": sudo is tried. */
export function useSudoFor(facts: CoolifyProbeFacts | null | undefined): boolean {
  if (!facts) return false;
  return facts.uid !== 0 && facts.dockerAccess !== true;
}

export type EnrollCheck = "fingerprint" | "address" | "unverified" | "mismatch";

/**
 * After the agent enrolled: is it the machine that was probed? The host key fingerprint the Coolify host's agent saw on the wire is compared
 * with the one the new agent reports about its own sshd. A different one means the token went to another machine. Without a reported
 * fingerprint the comparison falls back to the address: Coolify's address for the server against the addresses the agent reports (only a
 * public address counts, a private or Tailscale one proves nothing). The fallback never blocks: it only records how strong the proof was.
 */
export function checkEnrolled(i: { probedFp: string | null; reportedFp: string | null; coolifyAddress: string; reportedAddresses: Array<string | null | undefined> }): EnrollCheck {
  if (i.probedFp && i.reportedFp) return i.probedFp === i.reportedFp ? "fingerprint" : "mismatch";
  const want = normalizeAddress(i.coolifyAddress);
  if (want && isPublicAddress(want) && i.reportedAddresses.some((a) => normalizeAddress(a) === want)) return "address";
  return "unverified";
}

/** Map a failure of the hub-to-agent hop to one fixed code. */
export function codeOfError(e: unknown): CoolifySshResultCode {
  if (e instanceof AgentCommandTimeoutException) return "timeout";
  if (e instanceof AgentOfflineException || e instanceof AgentDisconnectedException) return "unreachable";
  if (e instanceof ForbiddenException) return "cancelled"; // the capability went away mid-run: the consent ended
  return "installer_failed";
}

/** A bounded async counting semaphore. */
export class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  constructor(private max: number) {
    this.free = max;
  }
  setMax(n: number): void {
    this.free += n - this.max;
    this.max = n;
    this.drain();
  }
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.free--;
        let done = false;
        resolve(() => {
          if (done) return;
          done = true;
          this.free++;
          this.drain();
        });
      };
      if (this.free > 0) grant();
      else this.waiters.push(grant);
    });
  }
  private drain(): void {
    while (this.free > 0 && this.waiters.length > 0) this.waiters.shift()!();
  }
  get inFlight(): number {
    return this.max - this.free;
  }
}
