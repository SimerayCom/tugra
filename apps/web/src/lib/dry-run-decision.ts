import type { MigrationRunDryRunItem, MigrationRunMode, MigrationRunParams, MigrationRunView } from "./types";

/**
 * The decision screen of a finished dry run: the technical projection (one list of items per step) turned into three
 * answers, "does anything stop the real run", "what do I still have to look at" and "what will it cost me". Pure: no I/O,
 * no i18n; the component renders the keys this module returns.
 */

/** A fix the operator can take for a warning. New kinds are added here and rendered in `dry-run-decision.tsx`. */
export type WarningFix = { kind: "link"; href: string; labelKey: string } | { kind: "safety"; labelKey: string } | { kind: "pin"; labelKey: string };

/** What the screen knows about one warning code. Everything is optional: an unknown warning still shows, with its own sentence and "Accept and continue". */
export interface WarningSpec {
  /** One short sentence that replaces the technical text of the code. */
  titleKey?: string;
  /** What accepting means, shown behind "More". */
  hintKey?: string;
  fix?: WarningFix;
  /** False when the operator must never accept it (nothing uses this yet; every code is acceptable by default). */
  acceptable?: boolean;
}

/** What the screen knows about one blocker code: how to get past it. */
export interface BlockerSpec {
  adviceKey: string;
  fix?: WarningFix;
}

/**
 * The registry of warnings, keyed by {@link warningKey}. To give a new warning a fix, add one entry here and its strings to
 * the migrationRun locale file; nothing else changes. A warning with no entry is still listed and can be accepted.
 *
 * (A www redirect or a redis.conf that the importer now carries by itself no longer raises a warning, so none is listed here.)
 */
export const WARNING_REGISTRY: Record<string, WarningSpec> = {
  "import.risk-warning:app.git.private": {
    titleKey: "migrationRun.decision.warn.gitPrivate",
    hintKey: "migrationRun.decision.warn.gitPrivateHint",
    fix: { kind: "link", href: "/sources", labelKey: "migrationRun.decision.fix.connectGit" },
  },
  "import.risk-warning:service.image.floating": {
    titleKey: "migrationRun.decision.warn.imageFloating",
    hintKey: "migrationRun.decision.warn.imageFloatingHint",
    fix: { kind: "pin", labelKey: "migrationRun.decision.fix.pinInReview" },
  },
  // the gate's own check of the same images (image apps and stack members): apps are pinned by digest in Details, members here
  "preflight.images-unpinned": {
    hintKey: "migrationRun.decision.warn.imageFloatingHint",
    fix: { kind: "pin", labelKey: "migrationRun.decision.fix.pinInReview" },
  },
  "import.risk-warning:app.image.transfer": {
    titleKey: "migrationRun.decision.warn.imageTransfer",
    hintKey: "migrationRun.decision.warn.imageTransferHint",
  },
  "import.risk-warning:service.files.needed": {
    titleKey: "migrationRun.decision.warn.filesNeeded",
    hintKey: "migrationRun.decision.warn.filesNeededHint",
  },
  "import.risk-warning:service.data.manual-large": {
    titleKey: "migrationRun.decision.warn.dataManualLarge",
    hintKey: "migrationRun.decision.warn.dataManualLargeHint",
  },
  "import.risk-warning:service.volume.size-unknown": {
    titleKey: "migrationRun.decision.warn.sizeUnknown",
    hintKey: "migrationRun.decision.warn.sizeUnknownHint",
  },
  "import.risk-warning:app.privileged": {
    titleKey: "migrationRun.decision.warn.privileged",
    hintKey: "migrationRun.decision.warn.privilegedHint",
  },
  "import.risk-warning:app.compose.path": {
    titleKey: "migrationRun.decision.warn.composePath",
    hintKey: "migrationRun.decision.warn.composePathHint",
  },
  "import.risk-warning:db.creds.missing": {
    titleKey: "migrationRun.decision.warn.dbCreds",
    hintKey: "migrationRun.decision.warn.dbCredsHint",
  },
  "import.risk-warning:db.version.missing": {
    titleKey: "migrationRun.decision.warn.dbVersion",
    hintKey: "migrationRun.decision.warn.dbVersionHint",
  },
};

/** How to get past a blocker. A code not listed gets {@link GENERIC_BLOCKER}. */
export const BLOCKER_REGISTRY: Record<string, BlockerSpec> = {
  "import.session-expired": { adviceKey: "migrationRun.decision.block.session" },
  "import.plan-changed": { adviceKey: "migrationRun.decision.block.planChanged", fix: { kind: "link", href: "/import", labelKey: "migrationRun.decision.fix.reviewAgain" } },
  "import.server-unmapped": { adviceKey: "migrationRun.decision.block.serverUnmapped", fix: { kind: "link", href: "/import", labelKey: "migrationRun.decision.fix.reviewAgain" } },
  "tls-preissue.acme-email": { adviceKey: "migrationRun.decision.block.acmeEmail" },
};
export const GENERIC_BLOCKER: BlockerSpec = { adviceKey: "migrationRun.decision.block.generic", fix: { kind: "link", href: "/import", labelKey: "migrationRun.decision.fix.reviewAgain" } };

/** Codes whose `risk` param names the warning (one code carries many risks). */
const RISK_CODES: ReadonlySet<string> = new Set(["import.risk-warning", "import.item-skipped"]);
/** The shape the hub accepts for a warning key (`PUT /migration-runs/:id/warning-acks`). */
const ACK_KEY_RE = /^[a-z0-9][a-z0-9.:_-]{1,119}$/;

/** The stable key of a warning: its code, plus `:<risk>` for a code that carries a risk. Acceptances are stored under it. */
export function warningKey(item: Pick<MigrationRunDryRunItem, "code" | "params">): string {
  const risk = item.params?.risk;
  return RISK_CODES.has(item.code) && typeof risk === "string" && risk ? `${item.code}:${risk}` : item.code;
}

/** True when the hub can store an acceptance under this key. A code outside the shape is shown but cannot be accepted. */
export const isAckableKey = (key: string): boolean => ACK_KEY_RE.test(key);

export interface DecisionIssue {
  /** The warning key (see {@link warningKey}); for a blocker the code. */
  key: string;
  code: string;
  level: MigrationRunDryRunItem["level"];
  /** What the items of this issue share; the first one's params (the sentence is built from them). */
  params?: MigrationRunParams;
  /** The subjects (item refs, host names) of every item of this issue, without repeats. */
  subjects: string[];
  /** How many dry-run items fold into this issue. */
  count: number;
  /** The step that raised the first of them. */
  step: string;
}

export interface DecisionSummary {
  apps: number | null;
  databases: number | null;
  services: number | null;
  /** Bytes to copy; null when the dry run could not measure them. */
  dataBytes: number | null;
  /** The window in which the source's writers are stopped; null = not estimated. */
  downtimeSec: number | null;
  /** The warm pass of the volumes (before the freeze) plus that window; null when either is not known. */
  durationSec: number | null;
}

export type DecisionVerdict = "blocked" | "warnings" | "clean";

export interface DryRunDecision {
  verdict: DecisionVerdict;
  blockers: DecisionIssue[];
  warnings: DecisionIssue[];
  /** The warnings the operator has not accepted or fixed (and can accept: a key the hub cannot store is only shown). */
  open: DecisionIssue[];
  accepted: DecisionIssue[];
  /** The warnings a pin fixed (the hub says which): they need no acceptance. */
  fixed: DecisionIssue[];
  summary: DecisionSummary;
}

const LEVEL_RANK = { block: 0, unknown: 1, warn: 2, info: 3 } as const;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Fold the dry-run items of every step into issues: one per code (and risk), subjects collected. Info items never become issues. */
function issuesOf(run: Pick<MigrationRunView, "steps">): DecisionIssue[] {
  const byKey = new Map<string, DecisionIssue>();
  for (const s of run.steps) {
    for (const i of s.progress?.dryRun ?? []) {
      if (i.level === "info") continue;
      // a blocker and a warning with the same code stay apart: they are different decisions
      const key = warningKey(i);
      const id = `${i.level === "warn" ? "w" : "b"}:${key}`;
      const cur = byKey.get(id);
      if (cur) {
        cur.count += 1;
        if (i.subject && !cur.subjects.includes(i.subject)) cur.subjects.push(i.subject);
        continue;
      }
      byKey.set(id, { key, code: i.code, level: i.level, ...(i.params ? { params: i.params } : {}), subjects: i.subject ? [i.subject] : [], count: 1, step: s.key });
    }
  }
  return [...byKey.values()].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** What the real run would cost, from the numbers the dry-run steps projected. A number the dry run did not give stays null: nothing is invented. */
export function summaryOf(run: Pick<MigrationRunView, "steps">): DecisionSummary {
  const all = run.steps.flatMap((s) => s.progress?.dryRun ?? []);
  const find = (code: string) => all.find((i) => i.code === code);
  const proj = find("import.projection")?.params;
  const est = find("data-seed.estimate")?.params;
  let sum = 0;
  let measured = false;
  for (const i of all) {
    const b = i.code === "data-seed.dry.volume" ? num(i.params?.rawBytes) : i.code === "data-seed.dry.db-lane" ? num(i.params?.dumpBytes) : null;
    if (b !== null) {
      sum += b;
      measured = true;
    }
  }
  // the hub's own total (volumes, dumps and unmeasured sizes it knows of) wins over the sum of what the rows show
  const dataBytes = num(est?.bytes) ?? (measured ? sum : null);
  const downtimeSec = num(est?.seconds);
  const warmSec = num(est?.warmSeconds);
  return {
    apps: num(proj?.apps),
    databases: num(proj?.databases),
    services: num(proj?.services),
    dataBytes,
    downtimeSec,
    durationSec: downtimeSec !== null && warmSec !== null ? downtimeSec + warmSec : null,
  };
}

/** The decision of a finished dry run, given the warning keys the operator already accepted and the ones the hub reports as fixed. */
export function decisionOf(run: Pick<MigrationRunView, "steps">, accepted: Iterable<string> = [], fixedKeys: Iterable<string> = []): DryRunDecision {
  const ok = new Set(accepted);
  const fix = new Set(fixedKeys);
  const issues = issuesOf(run);
  // block and unknown would stop the real run (the hub's contract for a dry-run item)
  const blockers = issues.filter((i) => i.level === "block" || i.level === "unknown");
  const warnings = issues.filter((i) => i.level === "warn");
  // a warning whose key the hub cannot store has no decision to take (nothing to accept), so it never holds Start back
  const open = warnings.filter((w) => !ok.has(w.key) && !fix.has(w.key) && isAckableKey(w.key));
  const done = warnings.filter((w) => ok.has(w.key));
  const fixed = warnings.filter((w) => fix.has(w.key) && !ok.has(w.key));
  return { verdict: blockers.length > 0 ? "blocked" : open.length > 0 ? "warnings" : "clean", blockers, warnings, open, accepted: done, fixed, summary: summaryOf(run) };
}

/** The registry entry of a warning, or an empty one (a warning nobody wrote a sentence for). */
export const warningSpec = (key: string): WarningSpec => WARNING_REGISTRY[key] ?? {};
export const blockerSpec = (code: string): BlockerSpec => BLOCKER_REGISTRY[code] ?? GENERIC_BLOCKER;

/** Whether a warning can be accepted from here: the registry allows it and the hub can store the key. */
export const canAccept = (key: string): boolean => warningSpec(key).acceptable !== false && isAckableKey(key);

export const ROLLBACK_PATH_KEY: Record<MigrationRunMode, string> = {
  copy: "migrationRun.decision.rollback.copy",
  takeover: "migrationRun.decision.rollback.takeover",
};

/** One floating image behind a warning, as the dry run lists it. `member` is empty for an image app. */
export interface PinEntry {
  itemRef: string;
  member: string;
  /** The image as the source writes it. */
  image: string;
  /** The concrete version the source's own record shows for it ("" = none: only a floating ref is known). */
  seen: string;
}

/** The floating images a warning carries (index-aligned arrays in its params); none when the hub sent none or they do not line up. */
export function pinEntriesOf(params: MigrationRunParams | undefined): PinEntry[] {
  const arr = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
  const items = arr(params?.imageItems);
  const members = arr(params?.imageMembers);
  const images = arr(params?.images);
  const seen = arr(params?.imageSeen);
  if (!items || !members || !images || !seen || members.length !== items.length || images.length !== items.length || seen.length !== items.length) return [];
  return items.map((itemRef, i) => ({ itemRef, member: members[i], image: images[i], seen: seen[i] }));
}

/** The entries of a warning a stack pin can fix (members of compose stacks whose image the dry run knows). */
export const memberPinEntries = (params: MigrationRunParams | undefined): PinEntry[] => pinEntriesOf(params).filter((e) => e.member !== "" && e.image !== "");

/** True when the warning also lists image apps (their pins are digests, set in Details). */
export const hasAppImages = (params: MigrationRunParams | undefined): boolean => pinEntriesOf(params).some((e) => e.member === "");

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** The repository of an image ref: tag and digest cut off, the registry host and port kept. */
export function imageRepo(image: string): string {
  const noDigest = image.split("@")[0];
  const last = noDigest.split("/").pop() ?? noDigest;
  const colon = last.indexOf(":");
  return colon < 0 ? noDigest : noDigest.slice(0, noDigest.length - (last.length - colon));
}

/**
 * The pin ref of what the operator typed for an image: a `sha256:` digest becomes `repo@sha256:...`, a version tag becomes `repo:tag`,
 * and `latest` (or anything else) is not a pin. Null when it is not usable. A full ref of the same repository is taken as it is.
 */
export function pinRefOf(image: string, typed: string): string | null {
  const v = typed.trim();
  if (!v) return null;
  const repo = imageRepo(image);
  if (DIGEST.test(v)) return `${repo}@${v}`;
  if (v.includes("/") || v.includes("@") || (v.includes(":") && !TAG.test(v))) {
    const same = imageRepo(v) === repo && v.length <= 300 && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/.test(v);
    const last = v.split("@")[0].split("/").pop() ?? v;
    const floating = !v.includes("@") && (!last.includes(":") || last.slice(last.indexOf(":") + 1) === "latest");
    return same && !floating ? v : null;
  }
  return TAG.test(v) && v !== "latest" ? `${repo}:${v}` : null;
}

/** What goes in the version box before the operator types: the tag or digest of the version the source shows ("" when it shows none). */
export function pinDraftOf(seen: string): string {
  if (!seen) return "";
  const at = seen.indexOf("@");
  if (at >= 0) return seen.slice(at + 1);
  const last = seen.split("/").pop() ?? seen;
  const colon = last.indexOf(":");
  return colon < 0 ? "" : last.slice(colon + 1);
}
