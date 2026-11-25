/**
 * The in-place takeover as pure logic (Coolify hub takeover, lane F): how a Coolify container becomes a Tugra item, how a test result is
 * judged against what Coolify served, the state machine of the takeover and of each domain's certificate, and the gate that stands
 * between "tested" and "take the ports". No database, no agent, no clock: the service feeds these what it read and acts on what they say.
 * Names, ids, counts and codes only; no environment value and no key ever enters this file.
 */
import type { TakeoverBuildMode, TakeoverCertState, TakeoverIssueCode, TakeoverItemView, TakeoverStatus } from "@tugra/shared";
import { appVolumeName } from "../deploy/deploy-script";
import type { CtrDetail, InPlaceRestartPolicy, ProbeResult } from "./inplace-scripts";

// ───────────────────────────── the item ─────────────────────────────

/** What the takeover keeps per app, beyond the view: the container recorded before anything is touched, and the Tugra side it maps to. */
export interface TakeoverItem extends TakeoverItemView {
  appId: string;
  /** Coolify's uuid of the app (the container-name prefix). */
  uuid: string;
  /** Git commit Coolify built (hex), when the app is git-based; carried onto the adopted deployment. */
  commitSha: string | null;
  /** The container Coolify runs for it, recorded with its identity; null when none runs (nothing to take over). */
  container: { id: string; name: string; image: string; restart: InPlaceRestartPolicy; imageId: string } | null;
  /** Mounts Coolify's container had that the Tugra app must see: its volume aliases and the bind mounts. */
  volumes: Array<{ from: string; to: string }>;
  binds: number;
  /** The container shares writable data (a volume or a bind) with Tugra's copy, so the two cannot run together: it is switched, not tested alongside. */
  exclusive: boolean;
  /** The synthetic deployment that carries the adopted image, and its tag. Set once the image was adopted. */
  adoptDeploymentId: string | null;
  adoptTag: string | null;
  /** The build with Tugra's own deployment, when the owner chose `rebuild-verify`. */
  rebuildDeploymentId: string | null;
  /** planned -> prepared (image/volumes ready, Tugra copy started when it can run alongside) -> switched (Tugra serves it) -> given-back. */
  state: "planned" | "prepared" | "switched" | "given-back" | "skipped";
  /** Why the app is not part of the takeover or needs the owner (stable codes). */
  issues: TakeoverIssueCode[];
  /** What Coolify's proxy answered for each domain before the switch (the yardstick of every later check). */
  baseline: Record<string, ProbeResult>;
  /** Serial of the fallback certificate per domain, once it was installed (hex), and when it started to be served. */
  fallbackSerial: Record<string, string | null>;
  fallbackAt: Record<string, string>;
  /** Failed attempts to get a new certificate, per domain. */
  certAttempts: Record<string, number>;
}

export type TakeoverIssue = TakeoverIssueCode;

/**
 * How the container's writable data lines up with the Tugra app's own volumes. A Coolify named volume mounted at a path becomes an alias
 * of the Tugra volume the app declares for that path (`appVolumeName`): no copy, the same data. A bind mount must be declared on the Tugra
 * app too (same host path and container path), because Tugra runs the container with its own mount list. A writable mount with no
 * counterpart is an issue and the app stays out of the takeover: starting it without its data would be worse than not starting it.
 */
export function mapMounts(
  detail: Pick<CtrDetail, "mounts">,
  app: { id: string; volumes: ReadonlyArray<{ name: string; path: string }>; hostMounts: ReadonlyArray<{ hostPath: string; containerPath: string }> },
): { volumes: Array<{ from: string; to: string }>; binds: number; exclusive: boolean; issues: TakeoverIssue[] } {
  const volumes: Array<{ from: string; to: string }> = [];
  const issues: TakeoverIssue[] = [];
  let binds = 0;
  let exclusive = false;
  for (const m of detail.mounts) {
    if (m.type === "tmpfs" || m.type === "other") continue;
    if (m.type === "volume") {
      const v = app.volumes.find((x) => x.path === m.destination);
      if (!v) {
        if (m.rw) issues.push("volume_unmapped");
        continue;
      }
      volumes.push({ from: m.source, to: appVolumeName(app, v.name) });
      if (m.rw) exclusive = true;
    } else {
      const h = app.hostMounts.find((x) => x.hostPath === m.source && x.containerPath === m.destination);
      if (!h) {
        if (m.rw) issues.push("bind_unmapped");
        continue;
      }
      binds += 1;
      if (m.rw) exclusive = true;
    }
  }
  return { volumes, binds, exclusive, issues: [...new Set(issues)] };
}

/** Tugra's versioned tag for the adopted image: `tugra_<appId>:<deploymentId>` (the tag the rollback path runs). */
export const adoptTagFor = (appId: string, deploymentId: string): string => `tugra_${appId}:${deploymentId}`;

// ───────────────────────────── judging a test ─────────────────────────────

export type CheckReason = "ok" | "status_only" | "preexisting" | "unreachable" | "server_error" | "status_differs" | "content_differs" | "no_answer";
export interface CheckVerdict {
  ok: boolean;
  reason: CheckReason;
}

/**
 * Is the answer through Tugra the answer Coolify gave? The status must be the same one, and not a server error. The content hash must
 * be the same too, unless Coolify's own page changed between two requests (a timestamp, a nonce): then only the status can be compared
 * (`status_only`). When the host could not hash, only the status is compared as well. An app that was already failing at Coolify passes
 * when it fails the same way (`preexisting`): the takeover does not make it worse, and it does not hide that it was broken.
 */
export function judgeProbe(baseline: ProbeResult | undefined, candidate: ProbeResult | undefined): CheckVerdict {
  if (!candidate) return { ok: false, reason: "no_answer" };
  if (candidate.status === null) return { ok: false, reason: "unreachable" };
  const b = baseline;
  const baseBroken = !b || b.status === null || b.status >= 500;
  if (baseBroken) {
    if (b && b.status !== null && candidate.status === b.status) return { ok: true, reason: "preexisting" };
    return candidate.status >= 500 ? { ok: false, reason: "server_error" } : { ok: true, reason: "ok" };
  }
  if (candidate.status >= 500) return { ok: false, reason: "server_error" };
  if (candidate.status !== b.status) return { ok: false, reason: "status_differs" };
  const stable = b.hash !== null && b.hash === b.hash2;
  if (!stable || candidate.hash === null) return { ok: true, reason: "status_only" };
  return candidate.hash === b.hash ? { ok: true, reason: "ok" } : { ok: false, reason: "content_differs" };
}

// ───────────────────────────── state machines ─────────────────────────────

const TRANSITIONS: Readonly<Record<TakeoverStatus, readonly TakeoverStatus[]>> = {
  PLANNED: ["TESTING", "GIVING_BACK", "FAILED"],
  TESTING: ["TESTING", "SWAPPING", "GIVING_BACK", "FAILED"],
  SWAPPING: ["SWAPPED", "GIVING_BACK", "FAILED"],
  SWAPPED: ["SWAPPED", "VERIFIED", "GIVING_BACK", "FAILED"],
  VERIFIED: ["VERIFIED", "SWAPPED", "GIVING_BACK"],
  GIVING_BACK: ["GIVEN_BACK", "FAILED"],
  GIVEN_BACK: [],
  FAILED: ["GIVING_BACK", "TESTING"],
};
export const canTakeoverTransition = (from: TakeoverStatus, to: TakeoverStatus): boolean => from === to || TRANSITIONS[from].includes(to);

/** From where the owner may give the server back to Coolify: anything that has started and not yet been given back. */
export const canGiveBack = (s: TakeoverStatus): boolean => s !== "GIVEN_BACK" && s !== "GIVING_BACK";
/** Tugra's proxy may own the box's ports from here on, so only the give-back undoes it. */
export const portsMayBeTugras = (s: TakeoverStatus): boolean => s === "SWAPPING" || s === "SWAPPED" || s === "VERIFIED" || s === "GIVING_BACK" || s === "FAILED";

const CERT_TRANSITIONS: Readonly<Record<TakeoverCertState, readonly TakeoverCertState[]>> = {
  pending: ["fallback", "issued", "failed"],
  fallback: ["issued", "failed"],
  issued: [],
  // a failed attempt put the fallback back, so the domain is served again and a later attempt may start from here
  failed: ["fallback", "issued", "failed"],
};
export const canCertTransition = (from: TakeoverCertState, to: TakeoverCertState): boolean => from === to || CERT_TRANSITIONS[from].includes(to);

/** How long Coolify's certificate may be the one served per domain before the hub works on replacing it (the owner said "a few minutes"). */
export const FALLBACK_MAX_MS = 10 * 60_000;
/** Attempts at a new certificate per domain before it is left to the owner. */
export const CERT_MAX_ATTEMPTS = 3;
/** Domains whose certificate is handled per verify call, so one request never holds the server for the whole fleet. */
export const CERT_BATCH = 5;

// ───────────────────────────── gates ─────────────────────────────

export type SwapGate = { ok: true } | { ok: false; code: "no_items" | "not_tested" | "test_failed" | "item_not_ready"; itemRef?: string; host?: string };

/**
 * May the ports be taken? Every app that takes part must be prepared. Every domain of an app that runs alongside must have PASSED the
 * temporary check. Apps that share data with Coolify's copy cannot run alongside, so their domains are checked right after the switch
 * instead (and "give back" is the answer to a failure there); they never block here for lack of a test, only for a prepared failure.
 */
export function swapGate(items: readonly TakeoverItem[]): SwapGate {
  const active = items.filter((i) => i.state !== "skipped");
  if (active.length === 0) return { ok: false, code: "no_items" };
  for (const i of active) {
    if (i.state !== "prepared") return { ok: false, code: "item_not_ready", itemRef: i.itemRef };
    if (i.exclusive) continue;
    for (const d of i.domains) {
      if (d.tempCheck === "failed") return { ok: false, code: "test_failed", itemRef: i.itemRef, host: d.host };
      if (d.tempCheck !== "ok") return { ok: false, code: "not_tested", itemRef: i.itemRef, host: d.host };
    }
  }
  return { ok: true };
}

/** Every domain of the apps that take part, with the app it belongs to. */
export function domainsOf(items: readonly TakeoverItem[]): Array<{ itemRef: string; host: string }> {
  return items.filter((i) => i.state !== "skipped").flatMap((i) => i.domains.map((d) => ({ itemRef: i.itemRef, host: d.host })));
}

/** Done when every domain passed its check after the swap and holds a new certificate. */
export function isVerified(items: readonly TakeoverItem[]): boolean {
  const active = items.filter((i) => i.state !== "skipped");
  return active.length > 0 && active.every((i) => i.domains.every((d) => d.finalCheck === "ok" && d.cert === "issued"));
}

/** What the screen is shown: no uuid, no container id, no tag, no baseline. */
export function toItemView(i: TakeoverItem): TakeoverItemView {
  return {
    itemRef: i.itemRef,
    name: i.name,
    buildMode: i.buildMode,
    ...(i.state === "skipped" ? { skipped: true } : {}),
    ...(i.exclusive ? { exclusive: true } : {}),
    ...(i.issues.length ? { issues: i.issues } : {}),
    domains: i.domains.map((d) => ({ host: d.host, tempCheck: d.tempCheck, finalCheck: d.finalCheck, cert: d.cert })),
  };
}

export const isBuildMode = (v: unknown): v is TakeoverBuildMode => v === "reuse-image" || v === "rebuild-verify";

/** Hex commit sha accepted onto the adopted deployment (a bad value is dropped: it only ever shows as the deployed commit). */
export const cleanCommit = (v: string | null | undefined): string | null => (v && /^[0-9a-f]{7,64}$/.test(v) ? v : null);
