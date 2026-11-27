import { InFlightRegistry } from "../in-flight/in-flight.registry";
import { randomBytes } from "node:crypto";
import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentCommandTimeoutException, AgentDisconnectedException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import { planTargets } from "../bulk/bulk.service";
import {
  buildCheckScript,
  buildPatchRunScript,
  parsePatchRun,
  type PatchGuard,
  buildUpgradeAllScript,
  buildUpgradeExceptEngineScript,
  type PatchScope,
  buildUpgradeOneScript,
  buildInstallPhasedScript,
  wrapHostExec,
  parseHostExec,
  parseUpgradable,
  type PatchInfo,
  type HostExecStatus,
} from "./patch-script";

const CHECK_TIMEOUT_MS = 120_000;
// In-container `timeout` backstop for the CHECK helper: BELOW the hub timeout so a slow check is killed cleanly
// in-container (clean marker, not a hub-side timeout).
const CHECK_HOST = { deadlineSec: 100, killSec: 5 };
// APPLY: the package manager runs as a host-side systemd unit capped at `unitSec`; the helper (and the hub call)
// only FOLLOW it. The whole apply may take unitSec + a margin for the unit's kill grace and the final read; within
// that the hub re-attaches as often as the engine restart makes it necessary.
const UPGRADE_ALL_UNIT_SEC = 1800;
const UPGRADE_ONE_UNIT_SEC = 900;
const APPLY_MARGIN_SEC = 150;
const ATTACH_KILL_SEC = 10;
const ATTACH_HUB_SLACK_MS = 30_000;

/** Pauses of the apply loop. A mutable object so tests can shrink it. */
export const patchTiming = {
  /** Pause before re-attaching after the helper ended or the agent was unreachable. */
  retryPauseMs: 5_000,
  /** Poll interval while waiting for the agent to reconnect (e.g. after the update restarted Docker). */
  onlinePollMs: 3_000,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The agent went away mid-attach (typically the update restarted Docker, taking the agent with it). The host-side
 *  unit is unaffected, so the hub re-attaches instead of reporting a failure. */
function isAgentDrop(e: unknown): boolean {
  return e instanceof AgentDisconnectedException || e instanceof AgentOfflineException || e instanceof AgentCommandTimeoutException;
}

/** Complete lines only: the part of a streamed log that can no longer change (a trailing partial line, or a
 *  half-arrived marker, is held back until its newline lands or the attach ends). */
function completeLines(text: string): string {
  const i = text.lastIndexOf("\n");
  return i < 0 ? "" : text.slice(0, i + 1);
}

/** Newline count = the resume point the host-side follower understands (immune to how the text was decoded). */
function countLines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** The agent caps a command's final Result.Output (64 KiB, then a truncation note) but not its live chunks. Prefer
 *  the accumulated chunks whenever they hold at least as much as the final output; fall back to it when none came. */
function fullerOutput(streamed: string, final: string): string {
  return streamed.length >= final.length ? streamed : final;
}

const applyScript = (scope: PatchScope): string => (scope === "except-engine" ? buildUpgradeExceptEngineScript() : buildUpgradeAllScript());
const applyGuard = (scope: PatchScope): PatchGuard => (scope === "except-engine" ? { kind: "except-engine" } : { kind: "all" });

/** A host-exec patch that could not enter the host → a clear message, never a silent mis-parse. */
function hostFailMessage(host: HostExecStatus): string {
  if (host.busy) return "a patch is already running on this server — wait for it to finish";
  return `host patching unavailable: ${host.unavailableReason ?? "the agent could not run the patch on the host"}`;
}
/** Inline (no-systemd) hosts must not upgrade the container engine from inside a container the engine runs. */
function engineBlockedMessage(names: string[]): string {
  return (
    `this server has no systemd, so the update would run inside the agent's helper container and ${names.join(", ")} ` +
    "(the container engine) cannot be upgraded from there — the engine restart would kill the update mid-way and leave dpkg half-configured. " +
    "Upgrade the engine packages from a shell on the server."
  );
}
// Fan-out caps for fleet ops: checks are cheap (parallel more), applies are heavy (fewer at once).
const FLEET_CHECK_CONCURRENCY = 8;
const FLEET_APPLY_CONCURRENCY = 3;

/** Per-server outcome of a fleet update check. `online=false` means the agent wasn't connected. */
export interface FleetPatchCheck {
  serverId: string;
  online: boolean;
  updates?: PatchInfo;
  error?: string;
}

/** Per-server outcome of a fleet update apply. */
export interface FleetPatchApply {
  serverId: string;
  online: boolean;
  exitCode?: number;
  error?: string;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order in the results. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

@Injectable()
export class PatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly deployLogs: DeployLogHub,
    private readonly inFlight: InFlightRegistry,
  ) {}

  async checkUpdates(userId: string, serverId: string): Promise<PatchInfo> {
    await this.requireWrite(userId, serverId);
    // Fail fast (before signing + audit) when the agent is offline, mirroring the bulk path's graceful
    // gate (checkUpdatesBulk) — a clean 503, never a masked 500. sendCommand's own guard is the backstop
    // for an agent that flaps offline mid-call.
    if (!this.agentWs.isOnline(serverId)) throw new AgentOfflineException();
    const r = await this.agentWs.sendCommand(serverId, wrapHostExec(buildCheckScript(), CHECK_HOST), "patch", CHECK_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.patch.check", target: serverId });
    // If the wrapper could not reach the host, surface that clearly — NOT a mis-parsed "unsupported OS".
    const host = parseHostExec(r.output);
    if (!host.entered) throw new ServiceUnavailableException(hostFailMessage(host));
    return parseUpgradable(r.output);
  }

  /**
   * `scope` "all" upgrades everything (the container engine too: Docker restarts and so does every app);
   * "except-engine" keeps the engine packages out of the run so the apps keep running.
   */
  async upgradeAll(userId: string, serverId: string, scope: PatchScope = "all"): Promise<{ output: string; exitCode: number }> {
    await this.requireWrite(userId, serverId);
    // Audited BEFORE it runs: an engine upgrade can take the hub itself down with Docker (the hub is a container on
    // the managed host in a single-server install), and an entry written only on completion would never exist.
    await this.audit.log({ actor: userId, action: "server.patch.apply", target: serverId, meta: { scope } });
    return this.runApply(serverId, applyScript(scope), applyGuard(scope), UPGRADE_ALL_UNIT_SEC, true);
  }

  async upgradeOne(userId: string, serverId: string, pkg: string): Promise<{ output: string; exitCode: number }> {
    await this.requireWrite(userId, serverId);
    const script = buildUpgradeOneScript(pkg); // validates the name before anything is audited or sent
    await this.audit.log({ actor: userId, action: "server.patch.apply", target: serverId, meta: { pkg } });
    return this.runApply(serverId, script, { kind: "one", pkg }, UPGRADE_ONE_UNIT_SEC, true);
  }

  /** Install ONE phased package now (apt), ahead of Ubuntu's gradual rollout reaching this server. Same host-side unit. */
  async upgradePhased(userId: string, serverId: string, pkg: string): Promise<{ output: string; exitCode: number }> {
    await this.requireWrite(userId, serverId);
    const script = buildInstallPhasedScript(pkg); // validates the name before anything is audited or sent
    await this.audit.log({ actor: userId, action: "server.patch.apply", target: serverId, meta: { pkg, phased: true } });
    return this.runApply(serverId, script, { kind: "one", pkg }, UPGRADE_ONE_UNIT_SEC, true);
  }

  /** Live build-log stream for the server's active patch run (replay + live). */
  async streamLogs(userId: string, serverId: string) {
    await this.requireWrite(userId, serverId);
    return this.deployLogs.subscribe(serverId);
  }

  /**
   * Check OS updates across many servers at once (fleet op). Each server is role-gated in its own
   * team via planTargets — non-writable / cross-team / unknown ids are SKIPPED (not an error), so
   * partial coverage is reported cleanly. An offline agent yields `online=false`; a per-server
   * failure is captured as `error` rather than failing the whole batch. Bounded fan-out.
   */
  async checkUpdatesBulk(userId: string, serverIds: string[]): Promise<{ results: FleetPatchCheck[]; skipped: string[] }> {
    const { targets, skipped } = await this.planFleet(userId, serverIds);
    const results = await mapPool(targets, FLEET_CHECK_CONCURRENCY, async (serverId): Promise<FleetPatchCheck> => {
      if (!this.agentWs.isOnline(serverId)) return { serverId, online: false };
      try {
        const r = await this.agentWs.sendCommand(serverId, wrapHostExec(buildCheckScript(), CHECK_HOST), "patch", CHECK_TIMEOUT_MS);
        const host = parseHostExec(r.output);
        if (!host.entered) return { serverId, online: true, error: hostFailMessage(host) };
        return { serverId, online: true, updates: parseUpgradable(r.output) };
      } catch (e) {
        return { serverId, online: true, error: e instanceof Error ? e.message : String(e) };
      }
    });
    if (targets.length > 0) {
      await this.audit.log({ actor: userId, action: "server.patch.check.bulk", target: targets.join(","), meta: { count: targets.length } });
    }
    return { results, skipped };
  }

  /**
   * Apply all OS updates across many servers at once (fleet op). Same role-gating/skip semantics as
   * checkUpdatesBulk; heavier, so a smaller fan-out. Reboots are never triggered here (the agent's
   * upgrade script never reboots), matching the single-server path.
   */
  async upgradeAllBulk(userId: string, serverIds: string[], scope: PatchScope = "all"): Promise<{ results: FleetPatchApply[]; skipped: string[] }> {
    const { targets, skipped } = await this.planFleet(userId, serverIds);
    if (targets.length > 0) {
      // Before the run, like the single-server apply: an engine upgrade can take the hub down with Docker.
      await this.audit.log({ actor: userId, action: "server.patch.apply.bulk", target: targets.join(","), meta: { count: targets.length, scope } });
    }
    const results = await mapPool(targets, FLEET_APPLY_CONCURRENCY, async (serverId): Promise<FleetPatchApply> => {
      if (!this.agentWs.isOnline(serverId)) return { serverId, online: false };
      try {
        const r = await this.runApply(serverId, applyScript(scope), applyGuard(scope), UPGRADE_ALL_UNIT_SEC, false);
        return { serverId, online: true, exitCode: r.exitCode };
      } catch (e) {
        return { serverId, online: true, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { results, skipped };
  }

  /** Resolve which of the requested servers the caller may operate on (servers:ops per team). */
  private async planFleet(userId: string, serverIds: string[]): Promise<{ targets: string[]; skipped: string[] }> {
    const servers = await this.prisma.server.findMany({ where: { id: { in: serverIds } }, select: { id: true, teamId: true } });
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const plan = planTargets(serverIds, servers, permsByTeam, "servers:ops");
    return {
      targets: plan.filter((p) => p.run).map((p) => p.serverId),
      skipped: plan.filter((p) => !p.run).map((p) => p.serverId),
    };
  }

  /**
   * Run an apply on the server: the package manager runs as a transient systemd unit on the HOST (see
   * buildPatchRunScript), this method follows it. An engine upgrade that restarts Docker drops the agent mid-way;
   * the unit does not care, so on a drop (or an attach that ended before the unit did) we wait for the agent and
   * re-send the SAME run id, which re-attaches after the log lines already received — never a second unit. Output
   * goes live to DeployLogHub when `stream` is set. Resolves with the package manager's own exit code.
   */
  private async runApply(
    serverId: string,
    inner: string,
    guard: PatchGuard,
    unitSec: number,
    stream: boolean,
  ): Promise<{ output: string; exitCode: number }> {
    // Registered so a hub or agent update waits for it (the host-side unit survives a restart, the hub's attach and live log do not).
    return this.inFlight.track({ kind: "patch", id: serverId, label: serverId, serverIds: [serverId] }, () => this.runApplyNow(serverId, inner, guard, unitSec, stream));
  }

  private async runApplyNow(
    serverId: string,
    inner: string,
    guard: PatchGuard,
    unitSec: number,
    stream: boolean,
  ): Promise<{ output: string; exitCode: number }> {
    const id = randomBytes(8).toString("hex");
    const deadlineAt = Date.now() + (unitSec + APPLY_MARGIN_SEC) * 1000;
    let log = ""; // the package manager's output we hold (the hub's view of the host log, complete lines only; its line count is the resume point)
    let pushed = 0; // chars of `log` already sent to the live stream
    let inline = false; // saw TUGRA_PATCH_MODE=inline: not resumable, a re-run would start the upgrade again
    const live = (text: string) => {
      if (stream && text.length > pushed) {
        this.deployLogs.push(serverId, text.slice(pushed));
        pushed = text.length;
      }
    };
    if (stream) this.deployLogs.begin(serverId);
    try {
      for (let attempt = 0; ; attempt++) {
        const remainingSec = Math.ceil((deadlineAt - Date.now()) / 1000);
        if (remainingSec < 30) {
          throw new ServiceUnavailableException("lost contact with the server during the update — it keeps running on the server; run a check to see where it ended up");
        }
        const script = wrapHostExec(
          buildPatchRunScript(inner, { id, deadlineSec: unitSec, lines: countLines(log), guard }),
          { deadlineSec: remainingSec, killSec: ATTACH_KILL_SEC },
        );
        let acc = "";
        const base = log;
        let r: { exitCode: number; output: string };
        try {
          r = await this.agentWs.sendCommand(serverId, script, "patch", remainingSec * 1000 + ATTACH_HUB_SLACK_MS, (c) => {
            acc += c;
            const st = parsePatchRun(acc);
            if (st.mode === "inline") inline = true;
            if (st.begun) live(base + completeLines(st.log));
          });
        } catch (e) {
          if (!isAgentDrop(e) || inline) throw e;
          // Keep what arrived (complete lines), then wait for the agent and re-attach.
          log = base + completeLines(parsePatchRun(acc).log);
          while (!this.agentWs.isOnline(serverId)) {
            if (Date.now() >= deadlineAt) throw e;
            await sleep(patchTiming.onlinePollMs);
          }
          continue;
        }
        // The agent caps the FINAL output at 64 KiB (the live chunks are not capped): a long upgrade would lose the
        // exit-code marker from r.output, so read the chunks we accumulated and keep r.output as the fallback.
        const out = fullerOutput(acc, r.output);
        const host = parseHostExec(out);
        const st = parsePatchRun(out);
        if (st.mode === "inline") inline = true;
        if (!host.entered) {
          // A leftover helper from before the restart may still hold the name for a moment: wait it out.
          if (host.busy && attempt > 0 && !inline) {
            await sleep(patchTiming.retryPauseMs);
            continue;
          }
          throw new ServiceUnavailableException(hostFailMessage(host));
        }
        if (st.busy) throw new ServiceUnavailableException(hostFailMessage({ ...host, busy: true }));
        if (st.engineBlocked) throw new ConflictException(engineBlockedMessage(st.engineBlocked));
        if (st.startFailed) throw new ServiceUnavailableException("could not start the update on the server (systemd-run failed)");
        log = base + (st.rc !== null ? st.log : completeLines(st.log));
        live(log);
        if (st.rc !== null) {
          const exitCode = st.rc < 0 ? 1 : st.rc;
          if (stream) this.deployLogs.finish(serverId, { status: exitCode === 0 ? "SUCCESS" : "FAILED", exitCode, deploymentId: serverId });
          const note = st.rc < 0 ? "\nthe update unit ended without reporting an exit code\n" : "";
          return { output: (log + note).slice(-65536), exitCode };
        }
        // The attach ended before the update did (the helper was removed, its own backstop fired): the unit is
        // still ours — attach again unless this was an inline run, which dies with its helper.
        if (inline) throw new ServiceUnavailableException("the update was interrupted before it finished");
        await sleep(patchTiming.retryPauseMs);
      }
    } catch (e) {
      // Any failure (refusal, lost agent, unexpected throw) ends the live stream as FAILED.
      if (stream) this.deployLogs.finish(serverId, { status: "FAILED", exitCode: -1, deploymentId: serverId });
      throw e;
    }
  }

  private async requireWrite(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
  }
}
