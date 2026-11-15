import type { ImportPlan, ImportPlanItem, ImportRisk, ImportRiskLevel, ImportOperation, ImportCoverageApp, ImportAck, ImportServiceChoice, ImportServicePreview, ImportServiceVerdict } from "./types";

// Pure view helpers for the import wizard. No network, no React — the data shaping the plan-review and
// apply-timeline screens render from (and the only part worth unit-testing).

export function hasBlocker(item: ImportPlanItem): boolean {
  return item.risks.some((r) => r.level === "blocker");
}

export function blockingRisks(item: ImportPlanItem): ImportRisk[] {
  return item.risks.filter((r) => r.level === "blocker");
}

export interface PlanSummary {
  apps: number;
  databases: number;
  volumes: number;
  blockers: number;
  warnings: number;
  runnable: number; // items that will actually be imported (not blocked)
  blocked: number;
}

export function planSummary(plan: ImportPlan): PlanSummary {
  const blocked = plan.items.filter(hasBlocker).length;
  return {
    apps: plan.totals.apps,
    databases: plan.totals.databases,
    volumes: plan.totals.volumes,
    blockers: plan.totals.blockers,
    warnings: plan.warnings.length,
    runnable: plan.items.length - blocked,
    blocked,
  };
}

/** Group plan items by kind for sectioned display (empty arrays kept so the UI can show "0 databases"). */
export function itemsByKind(plan: ImportPlan): Record<ImportPlanItem["kind"], ImportPlanItem[]> {
  const out: Record<ImportPlanItem["kind"], ImportPlanItem[]> = { app: [], database: [], volume: [], service: [] };
  for (const it of plan.items) out[it.kind].push(it);
  return out;
}

/** The verdict a service plan item carries in its `proposed` (the hub puts it there); anything else reads as skipped. */
export function serviceVerdictOf(item: ImportPlanItem): ImportServiceVerdict {
  const v = item.proposed?.verdict;
  return v === "importable" || v === "partial" ? v : "skipped";
}

/** The apply button is enabled only when at least one app (or one importable service stack) will actually be imported. */
export function canApply(plan: ImportPlan): boolean {
  return plan.items.some((it) => (it.kind === "app" && !hasBlocker(it)) || (it.kind === "service" && !hasBlocker(it) && serviceVerdictOf(it) !== "skipped"));
}

/**
 * The `serviceChoices` an apply sends: only entries for service items of THIS plan, with every empty field dropped, so a
 * card the operator never touched sends nothing (the apply then behaves exactly as the plan said). Undefined when empty.
 */
export function serviceChoicesPayload(plan: ImportPlan, choices: Record<string, ImportServiceChoice>): Record<string, ImportServiceChoice> | undefined {
  const refs = new Set(plan.items.filter((i) => i.kind === "service").map((i) => i.itemRef));
  const out: Record<string, ImportServiceChoice> = {};
  for (const [ref, c] of Object.entries(choices)) {
    if (!refs.has(ref)) continue;
    const clean: ImportServiceChoice = {};
    if (c.skip) clean.skip = true;
    if (c.name?.trim()) clean.name = c.name.trim();
    if (c.targetServerId) clean.targetServerId = c.targetServerId;
    if (c.environmentId) clean.environmentId = c.environmentId;
    if (c.serviceDomains) clean.serviceDomains = c.serviceDomains.filter((d) => d.hostname.trim() !== "").map((d) => ({ service: d.service, hostname: d.hostname.trim().toLowerCase(), port: d.port }));
    if (c.hostnameMap && Object.keys(c.hostnameMap).length) clean.hostnameMap = c.hostnameMap;
    if (c.volumes && Object.keys(c.volumes).length) clean.volumes = c.volumes;
    if (c.dropMembers?.length) clean.dropMembers = c.dropMembers;
    if (c.pinImages === false) clean.pinImages = false;
    if (c.pins && Object.keys(c.pins).length) clean.pins = c.pins;
    if (c.privateNetwork === false) clean.privateNetwork = false;
    if (c.hold === false) clean.hold = false;
    if (Object.keys(clean).length) out[ref] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A service that sits on the source's own host (Coolify names it `localhost`) has no sensible default placement: the
 *  operator must pick its target server explicitly (no silent default). */
export function needsExplicitTarget(card: Pick<ImportServicePreview, "sourceServer" | "verdict">, choice: ImportServiceChoice | undefined): boolean {
  return card.sourceServer === "localhost" && card.verdict !== "skipped" && !choice?.skip && !choice?.targetServerId;
}

/** UI tone token for a risk level (a class/color key, not a display string). */
export function riskTone(level: ImportRiskLevel): "danger" | "warning" | "info" {
  return level === "blocker" ? "danger" : level === "warn" ? "warning" : "info";
}

export interface OpProgress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  active: number; // pending + running
  pct: number; // 0–100, by terminal/total
  settled: boolean; // the operation has stopped (not RUNNING)
}

export function opProgress(op: ImportOperation): OpProgress {
  const t = op.totals;
  const active = t.running + t.pending;
  const terminal = Math.max(0, t.total - active);
  return {
    total: t.total,
    done: t.done,
    failed: t.failed,
    skipped: t.skipped,
    active,
    pct: t.total > 0 ? Math.round((terminal / t.total) * 100) : 100,
    settled: op.status !== "RUNNING",
  };
}

/** The apps with at least one "not carried over" entry (empty when the plan has no coverage report). */
export function coverageApps(plan: ImportPlan): ImportCoverageApp[] {
  return plan.preflight?.coverage?.apps.filter((a) => a.notCarried.length > 0) ?? [];
}

/** Counts for the coverage badge: apps listed, and entries needing a review (warn) vs plain notes (info). */
export function coverageCounts(plan: ImportPlan): { apps: number; warn: number; info: number } {
  const apps = coverageApps(plan);
  let warn = 0;
  let info = 0;
  for (const a of apps) for (const n of a.notCarried) (n.level === "warn" ? warn++ : info++);
  return { apps: apps.length, warn, info };
}

/** The deferred-read codes: those rows describe what happens when the Coolify plan is APPLIED (labels / Dockerfile text are
 *  read then). The note under the coverage card is only true for a plan that has one. */
const DEFERRED_REASON_CODES = new Set(["custom_labels_deferred", "dockerfile_deferred"]);

export function hasDeferredCoverage(plan: ImportPlan): boolean {
  return coverageApps(plan).some((a) => a.notCarried.some((n) => !!n.reasonCode && DEFERRED_REASON_CODES.has(n.reasonCode)));
}

/** The translated reason of a coverage / apply-timeline entry: `import.reason_<code>` with its params, the hub's English
 *  `reason` for a row with no (or an unknown) code, e.g. one persisted before the codes existed. */
export function reasonText(t: (k: string, v?: Record<string, string | number>) => string, e: { reason: string; reasonCode?: string; reasonParams?: Record<string, string | number> }): string {
  if (!e.reasonCode) return e.reason;
  const key = `import.reason_${e.reasonCode}`;
  const text = t(key, e.reasonParams);
  return text === key ? e.reason : text;
}

// ── strict env (Coolify): ackable blockers ──
/** The two blocker codes an operator may acknowledge ("create the app WITHOUT those variables"). The hub enforces the
 *  same allow-list; `app.env.tokenReadOnly` and every other blocker can never be acknowledged. */
export const ACKABLE_ENV_CODES = ["app.env.unresolved", "app.env.key.invalid"] as const;
export const ENV_TOKEN_READ_ONLY_CODE = "app.env.tokenReadOnly";
const isAckableCode = (c: string): c is (typeof ACKABLE_ENV_CODES)[number] => (ACKABLE_ENV_CODES as readonly string[]).includes(c);

/** The ackable env codes this item carries. */
export function ackableCodes(item: ImportPlanItem): ImportAck["code"][] {
  return item.risks.filter((r) => r.level === "blocker" && isAckableCode(r.code)).map((r) => r.code as ImportAck["code"]);
}

/** Is the item blocked even after the acknowledgements (a non-ackable blocker, or an ackable one not acknowledged)? */
export function blockedAfterAcks(item: ImportPlanItem, acked: ReadonlySet<string>): boolean {
  return item.risks.some((r) => r.level === "blocker" && !(isAckableCode(r.code) && acked.has(item.itemRef)));
}

/** Apps whose plan carries an ackable env blocker (the rows the operator must acknowledge or fix). */
export function ackableItems(plan: ImportPlan): ImportPlanItem[] {
  return plan.items.filter((it) => it.kind === "app" && ackableCodes(it).length > 0 && !it.risks.some((r) => r.code === ENV_TOKEN_READ_ONLY_CODE));
}

/** Apps whose token cannot read variable values (non-ackable: fix the token and reconnect). */
export function tokenReadOnlyItems(plan: ImportPlan): ImportPlanItem[] {
  return plan.items.filter((it) => it.kind === "app" && it.risks.some((r) => r.code === ENV_TOKEN_READ_ONLY_CODE));
}

/** Items that will actually be imported after the acknowledgements. */
export function runnableAfterAcks(plan: ImportPlan, acked: ReadonlySet<string>): number {
  return plan.items.filter((it) => !blockedAfterAcks(it, acked)).length;
}

/** The explicit per-item acks to send with apply (never an ack-all: each acknowledged app lists its own codes). */
export function buildAcks(plan: ImportPlan, acked: ReadonlySet<string>): ImportAck[] {
  const out: ImportAck[] = [];
  for (const it of plan.items) {
    if (!acked.has(it.itemRef)) continue;
    for (const code of ackableCodes(it)) out.push({ code, itemRef: it.itemRef });
  }
  return out;
}
