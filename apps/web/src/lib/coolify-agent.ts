// The agent path of the import wizard (Coolify hub takeover): the owner's consent for reading secret values, and the match of each
// Coolify server to a Tugra server. Pure helpers and the shapes of the hub's answers; nothing here holds a secret, an address or a key.
// Browser-safe subpaths: the package index also carries Node-only helpers (node:net) that must not reach the web bundle.
import { COOLIFY_SECRET_CLASSES, COOLIFY_SECRET_TIER, COOLIFY_SECRETS_GRANT_DEFAULT_HOURS } from "@tugra/shared/dist/coolify-secrets";
import { HOST_EVIDENCE_STRENGTH } from "@tugra/shared/dist/coolify-match";
import type { CoolifyHostGrantView, CoolifySecretClass, HostEvidence, HostEvidenceStrength } from "@tugra/shared";
import type { ImportPlan, ServerView } from "./types";

export type { CoolifyHostGrantView, CoolifySecretClass } from "@tugra/shared";

/** The classes ticked when the screen opens: tier 1 on, tier 2 (notification tokens, Git app keys, deploy keys) off until the owner opts in. */
export function defaultClasses(): CoolifySecretClass[] {
  return COOLIFY_SECRET_CLASSES.filter((c) => COOLIFY_SECRET_TIER[c] === "T1");
}

export const CONSENT_HOURS = [1, 4, COOLIFY_SECRETS_GRANT_DEFAULT_HOURS, 72, 168] as const;

/** Consent is the name of the Coolify host typed exactly: the owner reads what they are allowing. */
export function consentReady(typed: string, hostName: string): boolean {
  return hostName.length > 0 && typed === hostName;
}

/** The count of a class the read reports (`secretCounts` keys equal the class names, `s3` and `deploy_key` included), or null when it does not say. */
export function classCount(counts: Record<string, number> | undefined, cls: CoolifySecretClass): number | null {
  const n = counts?.[cls];
  return typeof n === "number" ? n : null;
}

/** The consent the plan says stands for this session (classes), or null. */
export function standingConsent(plan: Pick<ImportPlan, "preflight"> | null | undefined): CoolifySecretClass[] | null {
  const c = (plan?.preflight as { secretsConsent?: { classes?: string[] } } | undefined)?.secretsConsent?.classes;
  const known = (c ?? []).filter((x): x is CoolifySecretClass => (COOLIFY_SECRET_CLASSES as readonly string[]).includes(x));
  return known.length ? known : null;
}

/** An agent-read session: the one apply of it needs the owner's consent for secret values standing at that moment. */
export function needsConsent(plan: Pick<ImportPlan, "preflight"> | null | undefined): boolean {
  return !!plan?.preflight?.agentRead && standingConsent(plan) === null;
}

/** The hub refused an apply because the consent for secret values does not stand (never given, lapsed, or ended with an earlier apply). */
export function isConsentRequired(e: unknown): boolean {
  const x = e as { status?: unknown; code?: unknown } | null;
  return !!x && x.status === 403 && x.code === "consent_required";
}

export type MatchKind = "certain" | "probable" | "weak" | "none";

export interface EvidenceLine {
  kind: HostEvidence["kind"];
  strength: HostEvidenceStrength;
  equal: boolean;
}

/** Evidence as plain lines, strongest first: what proves it, what suggests it, what never decides. A conflict is listed too. */
export function evidenceLines(evidence: readonly HostEvidence[]): EvidenceLine[] {
  const order: Record<HostEvidenceStrength, number> = { identity: 0, address: 1, weak: 2 };
  return evidence
    .map((e) => ({ kind: e.kind, strength: HOST_EVIDENCE_STRENGTH[e.kind], equal: e.equal }))
    .sort((a, b) => order[a.strength] - order[b.strength] || Number(b.equal) - Number(a.equal));
}

type Host = NonNullable<NonNullable<ImportPlan["preflight"]>["hosts"]>[number];

export interface MatchRow {
  ref: string;
  name: string;
  controlPlane: boolean;
  /** certain (identity), probable (an address), weak (only a name or an unsure candidate set), none. */
  kind: MatchKind;
  status: "certain" | "probable" | "ambiguous" | "none";
  tugraServerId: string | null;
  tugraName: string | null;
  agentOnline: boolean;
  /** The owner answered for this server (their answer is shown, and can be taken back). */
  answeredByOwner: boolean;
  evidence: EvidenceLine[];
  /** An identity fact that DIFFERS: the owner cannot say it is the same machine. */
  identityConflict: boolean;
}

/** One row per source server of the plan (the Coolify host first), from what the hub's match said. Never an address. */
export function matchRows(plan: Pick<ImportPlan, "preflight"> | null | undefined): MatchRow[] {
  const hosts = plan?.preflight?.hosts ?? [];
  const rows = hosts.map((h: Host): MatchRow => {
    const evidence = evidenceLines(h.match?.evidence ?? []);
    const status = h.match?.status ?? (h.tugra ? h.tugra.confidence : "none");
    const weakOnly = evidence.length > 0 && evidence.every((e) => e.strength === "weak" || !e.equal);
    const kind: MatchKind = status === "certain" ? "certain" : status === "probable" ? "probable" : status === "ambiguous" || weakOnly ? "weak" : "none";
    return {
      ref: h.ref,
      name: h.name ?? h.ref,
      controlPlane: h.controlPlane === true,
      kind,
      status,
      tugraServerId: h.tugra?.serverId ?? null,
      tugraName: h.tugra?.name ?? null,
      agentOnline: h.agentOnline === true,
      answeredByOwner: h.match?.linkedBy === "user",
      evidence,
      identityConflict: evidence.some((e) => e.strength === "identity" && !e.equal),
    };
  });
  return rows.sort((a, b) => Number(b.controlPlane) - Number(a.controlPlane) || a.name.localeCompare(b.name));
}

/** The servers the owner may name as "the same machine": ones they can write to, the current match first. */
export function candidateServers(servers: readonly Pick<ServerView, "id" | "name" | "canWrite" | "status" | "teamId">[], row: Pick<MatchRow, "tugraServerId">): Array<{ id: string; name: string; online: boolean }> {
  return servers
    .filter((s) => s.canWrite)
    .map((s) => ({ id: s.id, name: s.name, online: s.status === "ONLINE" }))
    .sort((a, b) => Number(b.id === row.tugraServerId) - Number(a.id === row.tugraServerId) || a.name.localeCompare(b.name));
}

/** The owner can answer for a server that is not the Coolify host itself (that one is always "this server"). */
export function canAnswer(row: Pick<MatchRow, "controlPlane">): boolean {
  return !row.controlPlane;
}

/** Whether the step has anything to show: an agent read, with at least one source server. */
export function needsMatchStep(plan: Pick<ImportPlan, "preflight"> | null | undefined): boolean {
  return !!plan?.preflight?.agentRead && (plan.preflight.hosts?.length ?? 0) > 0;
}

/** How many source servers still wait for the owner: no sure match, and not the Coolify host. */
export function unsureCount(rows: readonly MatchRow[]): number {
  return rows.filter((r) => !r.controlPlane && (r.kind === "weak" || r.kind === "none" || r.kind === "probable") && !r.answeredByOwner).length;
}
