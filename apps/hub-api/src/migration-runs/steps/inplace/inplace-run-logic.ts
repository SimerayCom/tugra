/**
 * Pure rules of an in-place takeover run (Coolify hub takeover, lane F inside the guided run). No database, no agent, no clock: the
 * step handlers feed these what the takeover looks like and act on what they say. Codes, ids, counts and host names only.
 */
import type { HttpException } from "@nestjs/common";
import type { TakeoverFailureCode, TakeoverIssueCode } from "@tugra/shared";
import type { GateCheck } from "../../core/dto";
import type { RunSnapshot } from "../../core/run-contract";
import type { RunTakeoverState } from "../../../coolify-inplace/inplace-run";
import { checkKey } from "../data/data-logic";
import type { SuiteCheck } from "../data/verify/verify-suite";

/** A run is an in-place takeover when a campaign said so AND its topology is the same-machine swap (nothing else has a machine to take over). */
export const isInPlaceRun = (run: Pick<RunSnapshot, "inPlace" | "topology">): boolean => run.inPlace === true && run.topology === "swap-proxy";

/** How long the domains may keep failing their check right after the ports changed before CUTOVER fails (the owner decides: retry or give back). */
export const INPLACE_VERIFY_DEADLINE_MS = 5 * 60_000;
/** How long CUTOVER waits for every domain to hold a new certificate before it fails (retryable; the owner can give back). */
export const INPLACE_CERT_DEADLINE_MS = 30 * 60_000;
/** Poll interval while certificates are waited for (the hub also sweeps a switched server on its own timer). */
export const INPLACE_POLL_MS = 15_000;

/** Every code the in-place run steps emit (the web has a sentence for each; `run-codes-locale.spec` and the in-place spec check it). */
export const INPLACE_RUN_CODES = [
  "deploy-dark.inplace-plan",
  "deploy-dark.inplace-owner-only",
  "deploy-dark.inplace-server-busy",
  "deploy-dark.inplace-refused",
  "deploy-dark.inplace-probe-unavailable",
  "deploy-dark.inplace-test-failed",
  "deploy-dark.inplace-no-apps",
  "deploy-dark.inplace-not-tested",
  "deploy-dark.inplace-testing",
  "deploy-dark.inplace-give-back-failed",
  "verify.inplace-no-takeover",
  "verify.inplace-not-tested",
  "verify.inplace-domain-checked",
  "verify.inplace-domain-failed",
  "verify.inplace-domain-untested",
  "verify.inplace-switched",
  "verify.inplace-after-switch",
  "verify.inplace-database",
  "verify.inplace-service",
  "verify.inplace-app-left-out",
  "verify.inplace-app-no-domain",
  "verify.inplace-probe-unavailable",
  "cutover.dry.inplace",
  "cutover.inplace-owner-only",
  "cutover.inplace-server-busy",
  "cutover.inplace-refused",
  "cutover.inplace-not-tested",
  "cutover.inplace-swap-interrupted",
  "cutover.inplace-host-not-verified",
  "cutover.inplace-certs-pending",
  "cutover.inplace-not-verified",
  "cutover.inplace-give-back-failed",
  "cutover.inplace-probe-unavailable",
  "cutover.inplace-exclusive-policy-failed",
  "cutover.inplace-exclusive-stop-failed",
  "cutover.inplace-exclusive-start-failed",
  "cutover.inplace-swap-stop-failed",
  "cutover.inplace-swap-start-failed",
  "cutover.inplace-fallback-overdue",
  "cutover.inplace-cert-check-unavailable",
  "cutover.inplace-database-start-failed",
  "cutover.inplace-database-verify-failed",
  "cutover.inplace-service-not-ready",
  "cutover.inplace-service-verify-failed",
  "cutover.inplace-reversed",
] as const;
export type InPlaceRunCode = (typeof INPLACE_RUN_CODES)[number];

/** The cutover code of each takeover failure (a spec asserts that it covers every {@link TakeoverFailureCode}). */
export const CUTOVER_FAILURE: Readonly<Record<TakeoverFailureCode, InPlaceRunCode>> = {
  probe_unavailable: "cutover.inplace-probe-unavailable",
  exclusive_policy_failed: "cutover.inplace-exclusive-policy-failed",
  exclusive_stop_failed: "cutover.inplace-exclusive-stop-failed",
  exclusive_start_failed: "cutover.inplace-exclusive-start-failed",
  swap_stop_failed: "cutover.inplace-swap-stop-failed",
  swap_start_failed: "cutover.inplace-swap-start-failed",
  give_back_failed: "cutover.inplace-give-back-failed",
  fallback_overdue: "cutover.inplace-fallback-overdue",
  cert_check_unavailable: "cutover.inplace-cert-check-unavailable",
  database_start_failed: "cutover.inplace-database-start-failed",
  database_verify_failed: "cutover.inplace-database-verify-failed",
  service_not_ready: "cutover.inplace-service-not-ready",
  service_verify_failed: "cutover.inplace-service-verify-failed",
};

type Step = "deploy-dark" | "cutover";
const REFUSED: Readonly<Record<Step, InPlaceRunCode>> = { "deploy-dark": "deploy-dark.inplace-refused", cutover: "cutover.inplace-refused" };
const OWNER_ONLY: Readonly<Record<Step, InPlaceRunCode>> = { "deploy-dark": "deploy-dark.inplace-owner-only", cutover: "cutover.inplace-owner-only" };
const BUSY: Readonly<Record<Step, InPlaceRunCode>> = { "deploy-dark": "deploy-dark.inplace-server-busy", cutover: "cutover.inplace-server-busy" };

/**
 * A refusal of the takeover service turned into the run's own code and params. The service speaks Nest exceptions with a stable
 * `code`/message (`takeover_server_busy`, `takeover_control_plane`, ...); the run speaks codes. Anything that is not an HTTP refusal is
 * returned as `null` so the caller rethrows it (a lost lease must never become a step failure).
 */
export function refusalOf(step: Step, e: unknown): { code: InPlaceRunCode; params: Record<string, string>; retryable: boolean } | null {
  const he = e as Partial<HttpException> | null;
  if (!he || typeof he.getStatus !== "function" || typeof he.getResponse !== "function") return null;
  const status = he.getStatus();
  const res = he.getResponse() as unknown;
  const body = res && typeof res === "object" ? (res as { code?: unknown; message?: unknown; reason?: unknown }) : { message: res };
  const raw = typeof body.code === "string" ? body.code : typeof body.message === "string" ? body.message : "refused";
  const reason = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "refused";
  if (status === 403) return { code: OWNER_ONLY[step], params: {}, retryable: false };
  if (status === 409 && raw === "takeover_server_busy") return { code: BUSY[step], params: {}, retryable: true };
  return { code: REFUSED[step], params: { reason }, retryable: status === 409 };
}

// ───────────────────────────── what the owner reviews in VERIFY ─────────────────────────────

/** Skipped apps whose reason does not take a site away: nothing is served from them through the proxy anyway. */
const HARMLESS_SKIP: ReadonlySet<TakeoverIssueCode> = new Set<TakeoverIssueCode>(["no_domain"]);

const mk = (checkId: string, subject: string, c: Omit<GateCheck, "id" | "subject">): SuiteCheck => ({ ...c, id: checkKey(checkId, subject), checkId, subject });

/**
 * The review of an in-place takeover, as the checks VERIFY shows and binds the owner's approval to. A domain that does not answer the same
 * through Tugra's dark proxy blocks (nobody may accept it); an app that is left out of the takeover and has a domain would LOSE that
 * domain when Coolify's proxy stops, so the owner must accept it by name; an app that shares data with Coolify's copy is checked right
 * after the switch (and the give-back is the answer to a failure there), which is a warning, not a block.
 */
export function inPlaceSuite(state: RunTakeoverState | null): SuiteCheck[] {
  if (!state) return [mk("inplace-takeover", "", { status: "fail", code: "verify.inplace-no-takeover", evidence: "hub-verified" })];
  const out: SuiteCheck[] = [];
  if (state.status !== "TESTING") out.push(mk("inplace-takeover", "", { status: "fail", code: "verify.inplace-not-tested", params: { status: state.status }, evidence: "hub-verified" }));
  if (state.failureCode === "probe_unavailable") out.push(mk("inplace-probe", "", { status: "fail", code: "verify.inplace-probe-unavailable", evidence: "hub-verified" }));
  for (const i of state.items) {
    if (i.skipped) {
      const issues = i.issues ?? [];
      const harmless = issues.length > 0 && issues.every((x) => HARMLESS_SKIP.has(x));
      out.push(
        harmless
          ? mk("inplace-app", i.itemRef, { status: "warn", code: "verify.inplace-app-no-domain", params: { app: i.name }, evidence: "hub-verified" })
          : mk("inplace-app", i.itemRef, { status: "fail", code: "verify.inplace-app-left-out", params: { app: i.name, issues: issues.slice(0, 6) }, ackable: true, evidence: "hub-verified" }),
      );
      continue;
    }
    if (i.kind === "database") out.push(mk("inplace-switch", i.itemRef, { status: "warn", code: "verify.inplace-database", params: { app: i.name, level: i.verify?.level ?? "alive" }, evidence: "hub-verified" }));
    else if (i.kind === "service" && (i.exclusive || i.afterSwitch)) out.push(mk("inplace-switch", i.itemRef, { status: "warn", code: "verify.inplace-service", params: { app: i.name, members: (i.members ?? []).length }, evidence: "hub-verified" }));
    else if (i.afterSwitch) out.push(mk("inplace-switch", i.itemRef, { status: "warn", code: "verify.inplace-after-switch", params: { app: i.name }, evidence: "hub-verified" }));
    else if (i.exclusive) out.push(mk("inplace-switch", i.itemRef, { status: "warn", code: "verify.inplace-switched", params: { app: i.name }, evidence: "hub-verified" }));
    else
      for (const d of i.domains) {
        const code = d.tempCheck === "ok" ? "verify.inplace-domain-checked" : d.tempCheck === "failed" ? "verify.inplace-domain-failed" : "verify.inplace-domain-untested";
        out.push(mk("inplace-domain", d.host, { status: d.tempCheck === "ok" ? "pass" : "fail", code, params: { app: i.name }, evidence: "hub-verified" }));
      }
  }
  return out;
}

/** Hosts that fail their check through the proxy that now owns the box, and the domains that still wait for a new certificate. */
export function afterSwapFindings(state: RunTakeoverState): { checkFailed: string[]; noCert: string[] } {
  const checkFailed: string[] = [];
  const noCert: string[] = [];
  for (const i of state.items) {
    if (i.skipped) continue;
    for (const d of i.domains) {
      if (d.finalCheck === "failed") checkFailed.push(d.host);
      if (d.cert !== "issued") noCert.push(d.host);
    }
  }
  return { checkFailed, noCert };
}
