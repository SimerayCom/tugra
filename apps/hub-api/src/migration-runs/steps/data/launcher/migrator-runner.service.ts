import { Inject, Injectable } from "@nestjs/common";
import type { CodeParams } from "../../../core/dto";
import type { RunSnapshot, StepContext } from "../../../core/run-contract";
import { CAPABILITY_PORT, DATA_CODES, DATA_PORT, SOURCE_HOST_PORT, type CapabilityPort, type DataPort, type DataSnapshot, type SourceHostPort } from "../data-contract";
import { migratorFlags, type MigratorPhase } from "../data-logic";
import { classifyAgentError, compOf, releaseIfOurs, type LaunchRecord } from "../handler-util";
import { buildLaunchScript, buildLauncherStatusScript, buildLauncherStopScript, parseLaunchOutput, parseLauncherStatus, type LauncherStatus } from "./migrator-launcher";

export type RunnerFailure = { ok: false; code: string; params?: CodeParams; retryable: boolean };

/** Maximum launches of the migrator per step (a migrator that finishes without completing the work is not relaunched forever). */
export const MAX_LAUNCHES_PER_STEP = 3;
const SCRIPT_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 90_000;

/**
 * The `agent` source runner: starts, observes and stops the one-click migrator on the host the target agent lives on
 * (a same-host takeover). The migrator runs detached (see `migrator-launcher.ts`); this service only dispatches the
 * launcher scripts through the agent under the opt-in `migrate` capability and reads their results.
 */
@Injectable()
export class MigratorRunner {
  constructor(
    @Inject(SOURCE_HOST_PORT) private readonly host: SourceHostPort,
    @Inject(DATA_PORT) private readonly data: DataPort,
    @Inject(CAPABILITY_PORT) private readonly caps: CapabilityPort,
  ) {}

  /** Same-host is the only topology in which the target server IS the source host. */
  static available(run: RunSnapshot): boolean {
    return run.options.sourceRunner === "agent" && run.topology === "swap-proxy";
  }

  /** Observe the recorded launch (read-only on the host). null = nothing launched yet, or the agent is unreachable. */
  async status(run: RunSnapshot, launch: LaunchRecord | undefined): Promise<LauncherStatus | null> {
    if (!launch) return null;
    try {
      const res = await this.host.run(run.targetServerId, buildLauncherStatusScript(run.id, launch.seq), "migrate", SCRIPT_TIMEOUT_MS);
      return parseLauncherStatus(res.output);
    } catch {
      return null; // an unreachable agent is "unknown", never "finished"
    }
  }

  /**
   * Launch one phase. Writes the launch record to the step's compensation BEFORE the effect (so a crash right after
   * still lets the next tick find the run directory), grants the capability if needed, rotates the op's token and starts
   * the detached runner.
   */
  async launch(ctx: StepContext, phase: MigratorPhase, snap: DataSnapshot): Promise<{ ok: true } | RunnerFailure> {
    const run = ctx.run;
    if (!MigratorRunner.available(run)) return { ok: false, code: DATA_CODES.agentNeedsSameHost, retryable: false };
    const hubBase = (process.env.HUB_PUBLIC_URL?.trim() || snap.hubBase || "").replace(/\/+$/, "");
    if (!hubBase) return { ok: false, code: DATA_CODES.hubUrlUnknown, retryable: false };

    const granted = await this.caps.ensureMigrate(ctx.actor.userId, run.targetServerId);
    if (!granted.ok) return { ok: false, code: granted.reason === "forbidden" ? DATA_CODES.capabilityDenied : DATA_CODES.capabilityMissingTarget, retryable: false };
    const prior = compOf(ctx);
    if (granted.added) await ctx.recordCompensation({ capAdded: true });

    const seq = (prior.launchSeq ?? 0) + 1;
    if (seq > MAX_LAUNCHES_PER_STEP) return { ok: false, code: DATA_CODES.launcherFailed, params: { reason: "too-many-launches" }, retryable: true };
    await ctx.recordCompensation({ launchSeq: seq, launch: { seq, phase, at: ctx.now().toISOString() } satisfies LaunchRecord });
    await ctx.assertLease();

    let token: string;
    try {
      token = (await this.data.issueToken(run, hubBase)).token;
    } catch {
      return { ok: false, code: DATA_CODES.launcherFailed, params: { reason: "token-refused" }, retryable: true };
    }
    let script: string;
    try {
      script = buildLaunchScript({ runId: run.id, attempt: seq, hubBase, token, flags: migratorFlags(phase, run, snap) });
    } catch {
      return { ok: false, code: DATA_CODES.launcherFailed, params: { reason: "invalid-input" }, retryable: false };
    }
    try {
      const res = await this.host.run(run.targetServerId, script, "migrate", SCRIPT_TIMEOUT_MS);
      const outcome = parseLaunchOutput(res.output);
      if (outcome === "started" || outcome === "already") return { ok: true };
      return { ok: false, code: DATA_CODES.launcherFailed, params: { reason: outcome }, retryable: true };
    } catch (e) {
      const kind = classifyAgentError(e);
      return { ok: false, code: kind === "offline" ? DATA_CODES.agentOffline : kind === "forbidden" ? DATA_CODES.capabilityDenied : DATA_CODES.launcherFailed, params: { reason: kind }, retryable: true };
    }
  }

  /** Stop the migrator's own containers (abort path). Returns true when the host confirmed or there was nothing to do. */
  async stop(ctx: StepContext): Promise<boolean> {
    const run = ctx.run;
    if (!MigratorRunner.available(run)) return true;
    let addedNow = false;
    try {
      const granted = await this.caps.ensureMigrate(ctx.actor.userId, run.targetServerId);
      if (!granted.ok) return false;
      addedNow = granted.added;
      const res = await this.host.run(run.targetServerId, buildLauncherStopScript(), "migrate", STOP_TIMEOUT_MS);
      return !res.output.includes("TUGRA_MIG\tfailed");
    } catch {
      return false;
    } finally {
      await releaseIfOurs(ctx, this.caps, addedNow).catch(() => undefined); // least privilege: the grant ends with the abort
    }
  }
}
