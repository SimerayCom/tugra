/**
 * The seam between the in-place takeover and the guided migration run (Coolify hub takeover, lane F inside lane E). A guided run whose
 * source server is taken over in place drives {@link CoolifyInPlaceService} through this port: it never reads the takeover table or
 * runs a script itself. The run's own typed confirmations (the VERIFY approval, the PONR) stand in for the server name the standalone
 * takeover asks for, so the port has no `confirm`. Names, ids, counts and codes only.
 */
import type { TakeoverFailureCode, TakeoverItemView, TakeoverStatus } from "@tugra/shared";
import type { CoolifyProxySnapshot } from "../migration-runs/steps/cutover/proxy-swap";
import type { SwapGate } from "./inplace-plan";

export const INPLACE_RUN_PORT = Symbol("INPLACE_RUN_PORT");

/** What a guided run needs to know about the takeover that carries it. */
export interface RunTakeoverState {
  id: string;
  status: TakeoverStatus;
  failureCode: TakeoverFailureCode | null;
  items: TakeoverItemView[];
  /** May the ports be taken? Judged by the same gate the standalone takeover uses. */
  gate: SwapGate;
  /** Apps still being prepared (a rebuild that has not finished): the test is not complete yet. */
  pending: number;
  /** Domains that have not been checked or have no new certificate while attempts are left: a verify pass still has work to do. */
  certWorkLeft: boolean;
  /** Every domain works through Tugra's proxy and holds a new certificate. */
  verified: boolean;
  /** Coolify's proxy as it was found (identity and restart policy, no environment) and the bind Tugra's proxy had: what the run's swap record keeps. */
  proxy: CoolifyProxySnapshot;
  bindBefore: string;
}

export interface InPlaceRunPort {
  /** The latest takeover of the run, or null when none was planned yet. */
  runState(userId: string, runId: string): Promise<RunTakeoverState | null>;
  /** Plan (when there is no live takeover for the run) and test: idempotent, safe to call again after a fix. */
  runPrepare(userId: string, input: { runId: string; serverId: string; opId: string }): Promise<RunTakeoverState>;
  /** Take the ports. The takeover must be tested; the run's approval has already been given. */
  runSwap(userId: string, runId: string): Promise<RunTakeoverState>;
  /** One pass of re-check and new certificates (a few domains per call). */
  runVerify(userId: string, runId: string): Promise<RunTakeoverState>;
  /** Give the server back to Coolify; null when the run has no takeover to give back. */
  runGiveBack(userId: string, runId: string): Promise<RunTakeoverState | null>;
}
