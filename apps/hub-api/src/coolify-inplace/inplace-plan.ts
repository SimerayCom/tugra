/**
 * The in-place takeover as pure logic (Coolify hub takeover, lane F): how a Coolify container becomes a Tugra item, how a test result is
 * judged against what Coolify served, the state machine of the takeover and of each domain's certificate, and the gate that stands
 * between "tested" and "take the ports". No database, no agent, no clock: the service feeds these what it read and acts on what they say.
 * Names, ids, counts and codes only; no environment value and no key ever enters this file.
 */
import { iconKeyForImages } from "@tugra/shared";
import type { TakeoverAnswer, TakeoverBuildMode, TakeoverCertState, TakeoverCheckReason, TakeoverDomainCheck, TakeoverIssueCode, TakeoverItemView, TakeoverStatus } from "@tugra/shared";
import { appVolumeName } from "../deploy/deploy-script";
import { dbExtraVolumeName, dbVolumeName } from "../databases/database-script";
import type { ComposeNetworkRow } from "../deploy/deploy-script";
import type { CtrDetail, DbFingerprint, InPlaceRestartPolicy, ProbeResult, RecordedCtr } from "./inplace-scripts";
import { memberViews, type ServiceMemberRecord } from "./inplace-service";

// ───────────────────────────── the item ─────────────────────────────

/** What the takeover keeps per app, beyond the view: the container recorded before anything is touched, and the Tugra side it maps to. */
export interface TakeoverItem extends Omit<TakeoverItemView, "members"> {
  appId: string;
  /** Coolify's uuid of the app (the container-name prefix). */
  uuid: string;
  /** Git commit Coolify built (hex), when the app is git-based; carried onto the adopted deployment. */
  commitSha: string | null;
  /** The container Coolify runs for it, recorded with its identity; null when none runs (nothing to take over). */
  container: { id: string; name: string; image: string; restart: InPlaceRestartPolicy; imageId: string; repoDigests?: string[]; imageVersion?: string } | null;
  /** Mounts Coolify's container had that the Tugra app must see: its volume aliases and the bind mounts. */
  volumes: Array<{ from: string; to: string }>;
  binds: number;
  /** The container shares writable data (a volume or a bind) with Tugra's copy, so the two cannot run together: it is switched, not tested alongside. */
  exclusive: boolean;
  /**
   * The app talks to a database that is taken over in place (or Tugra could not read its environment to tell). That database is not there for
   * Tugra's copy until the switch, so the copy cannot be tested alongside: it is started after the databases and checked after the switch.
   */
  afterSwitch?: boolean;
  /**
   * Services only: every container of the Coolify service mapped to the compose service of the Tugra app, in start order (dependencies first).
   * `container` stays null for a service: its containers are the members.
   */
  members?: ServiceMemberRecord[];
  /** Services only: the compose project Tugra runs the service under (its containers' project label). */
  project?: string;
  /** Services only: the network attachments the Tugra compose app had before the takeover added Coolify's (null = none), kept to put back. Absent until the takeover changed them. */
  networksBefore?: ComposeNetworkRow[] | null;
  /** Services only: the attachments the takeover applies at the switch (the app's own plus Coolify's networks under their aliases). */
  networksWanted?: ComposeNetworkRow[];
  /** Databases only: the engine, and what Coolify's container showed before anything changed (the yardstick of the check after the switch). */
  engine?: string;
  dbBefore?: DbFingerprint | null;
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
  /** When the domain FIRST started to be served with Coolify's certificate. Unlike `fallbackAt` it is not reset when a failed attempt puts the fallback back. */
  fallbackSince?: Record<string, string>;
  /** Failed attempts to get a new certificate, per domain. */
  certAttempts: Record<string, number>;
  /** When Tugra's copy of the app was started next to Coolify's (the clock of the readiness deadline). Plain apps only. */
  startedAt?: string;
  /** When its container was first seen running and healthy on two polls in a row; the test through the dark proxy is not judged before this (plus a short settle). */
  readyAt?: string;
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

/**
 * How a Coolify database container's data lines up with the Tugra database's own volumes: the volume at the engine's data directory becomes an
 * alias of the Tugra database's data volume, an extra volume mounted at a path the Tugra database declares becomes an alias of that extra
 * volume. No copy: the same files. A writable mount with no counterpart (or the data directory as a bind mount, or not mounted at all) is an
 * issue and the database stays out of the takeover: starting it without its data would be worse than not starting it.
 */
export function mapDbMounts(
  detail: Pick<CtrDetail, "mounts">,
  db: { id: string; dataMount: string; volumes: ReadonlyArray<{ name: string; path: string }> },
): { volumes: Array<{ from: string; to: string }>; issues: TakeoverIssue[] } {
  const volumes: Array<{ from: string; to: string }> = [];
  const issues: TakeoverIssue[] = [];
  let data = false;
  for (const m of detail.mounts) {
    if (m.type === "tmpfs" || m.type === "other") continue;
    if (m.destination === db.dataMount) {
      if (m.type !== "volume" || !m.rw) issues.push("db_volume_unmapped");
      else {
        volumes.push({ from: m.source, to: dbVolumeName(db) });
        data = true;
      }
      continue;
    }
    if (m.type === "volume") {
      const v = db.volumes.find((x) => x.path === m.destination);
      if (v) volumes.push({ from: m.source, to: dbExtraVolumeName(db, v.name) });
      else if (m.rw) issues.push("db_volume_unmapped");
    } else if (m.rw) issues.push("db_volume_unmapped");
  }
  if (!data) issues.push("db_volume_unmapped");
  return { volumes, issues: [...new Set(issues)] };
}

/**
 * The same image, spelled the same way docker would (the default registry and the implicit `latest` do not make two images different).
 * A record pinned to the exact image (`repo:tag@sha256:...`) is the same image as the container that runs `repo:tag`: the digest is
 * what the pin adds, never a difference. When both sides carry a digest they must agree.
 */
export const sameImageRef = (a: string, b: string): boolean => {
  const [ra, da] = splitDigest(normImage(a));
  const [rb, db] = splitDigest(normImage(b));
  return ra === rb && (da === null || db === null || da === db);
};
function splitDigest(ref: string): [string, string | null] {
  const at = ref.indexOf("@");
  return at < 0 ? [ref, null] : [ref.slice(0, at), ref.slice(at + 1)];
}
function normImage(ref: string): string {
  let r = ref.trim().toLowerCase().replace(/^docker\.io\//, "").replace(/^library\//, "");
  if (!r.includes("@") && !/:[^/]+$/.test(r)) r += ":latest";
  if (r.includes("@")) {
    const [repo, digest] = [r.slice(0, r.indexOf("@")), r.slice(r.indexOf("@"))];
    return /:[^/]+$/.test(repo) ? r : `${repo}:latest${digest}`;
  }
  return r;
}

/** Tugra's versioned tag for the adopted image: `tugra_<appId>:<deploymentId>` (the tag the rollback path runs). */
export const adoptTagFor = (appId: string, deploymentId: string): string => `tugra_${appId}:${deploymentId}`;

// ───────────────────────────── judging a test ─────────────────────────────

export type CheckReason = TakeoverCheckReason;
export interface CheckVerdict {
  ok: boolean;
  reason: CheckReason;
}

/** What one side answered, as the screen shows it (never a body, never a query string). */
export const answerOf = (p: ProbeResult | undefined): TakeoverAnswer | null => (p ? { status: p.status, bytes: p.size ?? null, location: p.location ?? null } : null);

/** The verdict of a domain that did not pass, with what each side answered. */
export const checkOf = (reason: CheckReason, coolify: ProbeResult | undefined, tugra: ProbeResult | undefined): TakeoverDomainCheck => ({ reason, coolify: answerOf(coolify), tugra: answerOf(tugra) });

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

/**
 * From where the owner may give the server back to Coolify: anything not yet given back. GIVING_BACK is included: a give-back that the hub
 * restarted in the middle of (or that died on an error) is pressed again. A give-back that is really running holds the takeover's in-process
 * lock, so a second press during it is refused as busy and never runs twice.
 */
export const canGiveBack = (s: TakeoverStatus): boolean => s !== "GIVEN_BACK";
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
/** Domains of switched apps that still serve Coolify's certificate (or a failed attempt) past {@link FALLBACK_MAX_MS}. Hosts only. */
export function overdueFallbacks(items: readonly TakeoverItem[], now: Date): string[] {
  const out: string[] = [];
  for (const i of items) {
    if (i.state !== "switched") continue;
    for (const d of i.domains) {
      if (d.cert === "issued") continue;
      const since = i.fallbackSince?.[d.host] ?? i.fallbackAt[d.host];
      if (since && now.getTime() - new Date(since).getTime() > FALLBACK_MAX_MS) out.push(d.host);
    }
  }
  return out;
}

/** Whether a verify pass still has anything to do on its own: a domain without a new certificate that has attempts left, or an unflagged overdue one. */
export function certWorkLeft(items: readonly TakeoverItem[]): boolean {
  return items.some((i) => i.state === "switched" && i.domains.some((d) => d.cert !== "issued" && (i.certAttempts[d.host] ?? 0) < CERT_MAX_ATTEMPTS));
}

/** Whether a switched domain has no new certificate and has used every attempt: it is left to the owner (a manual check or a CUTOVER retry gives it new attempts). */
export const certExhausted = (item: TakeoverItem, host: string, cert: string): boolean => item.state === "switched" && cert !== "issued" && (item.certAttempts[host] ?? 0) >= CERT_MAX_ATTEMPTS;

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
    if (i.exclusive || i.afterSwitch) continue;
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
  const domainsDone = (i: TakeoverItem): boolean => i.domains.every((d) => d.finalCheck === "ok" && d.cert === "issued");
  return active.length > 0 && active.every((i) => (i.kind === "database" ? i.verify?.state === "ok" : i.kind === "service" ? membersVerified(i) && domainsDone(i) : domainsDone(i)));
}

/** The containers an item of the takeover stands for on the Coolify side, in the order they are STARTED (a service: dependencies first; stop is the reverse). */
export function ctrsOf(i: Pick<TakeoverItem, "container" | "members" | "itemRef">): Array<RecordedCtr & { restart: InPlaceRestartPolicy; ports: string; itemRef: string }> {
  const one = (c: { id: string; name: string; image: string; restart: InPlaceRestartPolicy }) => ({ id: c.id, name: c.name, image: c.image, restart: c.restart, ports: "", itemRef: i.itemRef });
  if (i.members && i.members.length > 0) return i.members.map((m) => one(m.container));
  return i.container ? [one(i.container)] : [];
}

/**
 * The containers to STOP for an item, in stop order (a service: dependents first, so what writes goes quiet before what it writes to; the
 * reverse of the start order). `rest` and `db` split a service's members into the database-like ones (stopped last, after their yardstick was
 * read again) and the others; `all` is every one.
 */
export function stopCtrs(i: Pick<TakeoverItem, "container" | "members" | "itemRef">, part: "all" | "rest" | "db" = "all"): ReturnType<typeof ctrsOf> {
  const rev = [...ctrsOf(i)].reverse();
  if (part === "all" || !i.members || i.members.length === 0) return part === "db" ? [] : rev;
  const dbIds = new Set(i.members.filter((m) => m.engine).map((m) => m.container.id));
  return rev.filter((c) => (part === "db") === dbIds.has(c.id));
}

/** Does the item have Coolify containers to switch (an app or database with its container, a service with its members)? */
export const hasCtrs = (i: Pick<TakeoverItem, "container" | "members">): boolean => !!i.container || (i.members?.length ?? 0) > 0;

/** A service is done when every member came up ready and every database-like member answered the same, besides its domains. */
export const membersVerified = (i: Pick<TakeoverItem, "members">): boolean => (i.members ?? []).length > 0 && (i.members ?? []).every((m) => m.ready === "ok" && (!m.engine || m.dbVerify?.state === "ok"));

/** What the screen is shown: no uuid, no container id, no tag, no baseline. */
export function toItemView(i: TakeoverItem): TakeoverItemView {
  const iconKey = iconKeyForImages([i.container?.image, ...(i.members ?? []).map((m) => m.container.image)]);
  return {
    itemRef: i.itemRef,
    name: i.name,
    ...(i.appId ? { appId: i.appId } : {}),
    ...(iconKey ? { iconKey } : {}),
    ...(i.kind === "database" ? { kind: i.kind, ...(i.verify ? { verify: i.verify } : {}) } : {}),
    ...(i.kind === "service" ? { kind: i.kind, members: memberViews(i.members ?? []) } : {}),
    buildMode: i.buildMode,
    ...(i.state === "skipped" ? { skipped: true } : {}),
    ...(i.exclusive ? { exclusive: true } : {}),
    ...(i.rebuildDeclined ? { rebuildDeclined: true } : {}),
    ...(i.afterSwitch ? { afterSwitch: true } : {}),
    ...(i.issues.length ? { issues: i.issues } : {}),
    domains: i.domains.map((d) => ({ host: d.host, tempCheck: d.tempCheck, finalCheck: d.finalCheck, cert: d.cert, ...(d.check ? { check: d.check } : {}) })),
  };
}

export const isBuildMode = (v: unknown): v is TakeoverBuildMode => v === "reuse-image" || v === "rebuild-verify";

/** Hex commit sha accepted onto the adopted deployment (a bad value is dropped: it only ever shows as the deployed commit). */
export const cleanCommit = (v: string | null | undefined): string | null => (v && /^[0-9a-f]{7,64}$/.test(v) ? v : null);
