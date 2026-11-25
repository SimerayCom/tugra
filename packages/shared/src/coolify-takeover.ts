/**
 * Coolify hub takeover (agent import), the cross-lane contract: how an import session reaches its source, what the agent read adds
 * to the plan, where each source server lands, and the campaign of runs a mixed placement becomes. Types and constants only.
 * Plan-side additions are optional and sit outside `planHash`, like the rest of the preflight. Lane A owns the session and plan
 * half, lane E the placement and campaign half.
 */
import type { HostEvidence, HostLinkedBy, HostMatchStatus } from "./coolify-match";
import type { UnreadableValue } from "./coolify-secrets";

// ── session transport (lane A) ─────────────────────────────────────────────────────────────────────

/** How an import session reads its source. `sourceKind` stays "coolify" for both: a new kind would split every union that names one. */
export const IMPORT_TRANSPORTS = ["api", "agent"] as const;
export type ImportTransport = (typeof IMPORT_TRANSPORTS)[number];

/** An agent session's synthetic base URL, so the mapping key and the URL checks keep working: `agent://<serverId>`. */
export const AGENT_SESSION_URL_PREFIX = "agent://";
export const agentSessionBaseUrl = (serverId: string): string => `${AGENT_SESSION_URL_PREFIX}${serverId}`;
export const isAgentSessionBaseUrl = (baseUrl: string): boolean => baseUrl.startsWith(AGENT_SESSION_URL_PREFIX) && baseUrl.length > AGENT_SESSION_URL_PREFIX.length;

/** What the agent read says about itself. Counts and versions only. Absent on an API session. */
export interface AgentReadMeta {
  transport: "agent";
  agentServerId: string;
  /** Last applied Coolify migration name and the `coolify` image tag the reader saw. */
  schemaVersion: string | null;
  coolifyImage: string | null;
  readAt: string;
  counts: { teams: number; projects: number; servers: number; applications: number; databases: number; services: number };
  /** Counts of secret values by consent class, before anything is read (the consent screen quotes these). */
  secretCounts?: Record<string, number>;
}

/** The Coolify team an item belongs to (the agent read sees every team in one pass). Name and ref only. */
export interface PlanTeam {
  ref: string;
  name: string;
}

/** Fields the agent read fills on top of the API-path plan. All optional so the API path stays valid unchanged. */
export interface AgentPlanAdditions {
  agentRead?: AgentReadMeta;
  teams?: PlanTeam[];
  unreadable?: UnreadableValue[];
}

// ── placement and campaign (lane E) ────────────────────────────────────────────────────────────────

/** Where a source server's items land: on the same machine (proxy swap, no data copy) or on another Tugra server. */
export const PLACEMENT_KINDS = ["in-place", "other-server"] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];

/** Why "in-place" is not offered for a server (the UI shows the line; the hub refuses the choice). */
export const PLACEMENT_LOCK_REASONS = ["match_uncertain", "agent_offline", "control_plane", "agent_missing"] as const;
export type PlacementLockReason = (typeof PLACEMENT_LOCK_REASONS)[number];

/** One source server's placement choice. `targetServerId` is the Tugra server: the matched one for in-place, the chosen one otherwise. */
export interface SourcePlacement {
  sourceServerRef: string;
  kind: PlacementKind;
  targetServerId: string | null;
}

/** What the screen needs to render one source server's choice. Verdict only; no address. */
export interface SourceServerPlacementView {
  sourceServerRef: string;
  name: string;
  matchStatus: HostMatchStatus;
  linkedBy: HostLinkedBy | null;
  evidence: HostEvidence[];
  matchedServerId: string | null;
  agentOnline: boolean;
  controlPlane: boolean;
  inPlaceLocked: PlacementLockReason | null;
  suggested: PlacementKind | null;
}

/** One guided run of a campaign: one source server, one target, one topology. */
export interface CampaignRunPlan {
  sourceServerRef: string;
  kind: PlacementKind;
  targetServerId: string;
  topology: "swap-proxy" | "two-box";
  /** Waves run in order; the runs of one wave may run together. */
  wave: number;
}

export const CAMPAIGN_STATUSES = ["draft", "running", "paused", "done", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** A campaign as the API returns it. The run ids are MigrationRun ids; `label` is the value of `MigrationRun.campaign`. */
export interface CampaignView {
  id: string;
  label: string;
  sessionId: string | null;
  status: CampaignStatus;
  plan: CampaignRunPlan[];
  runIds: string[];
  createdAt: string;
}

// ── takeover in place (lane F) ─────────────────────────────────────────────────────────────────────

export const TAKEOVER_STATUSES = ["PLANNED", "TESTING", "SWAPPING", "SWAPPED", "VERIFIED", "GIVING_BACK", "GIVEN_BACK", "FAILED"] as const;
export type TakeoverStatus = (typeof TAKEOVER_STATUSES)[number];

/** Certificates: Coolify's one is a short fallback only; a new Let's Encrypt one is the goal. */
export const TAKEOVER_CERT_STATES = ["pending", "fallback", "issued", "failed"] as const;
export type TakeoverCertState = (typeof TAKEOVER_CERT_STATES)[number];

/** Per app: reuse the image Coolify built (default) or rebuild with Tugra and verify. */
export type TakeoverBuildMode = "reuse-image" | "rebuild-verify";

export interface TakeoverItemView {
  itemRef: string;
  name: string;
  buildMode: TakeoverBuildMode;
  domains: Array<{ host: string; tempCheck: "pending" | "ok" | "failed"; finalCheck: "pending" | "ok" | "failed"; cert: TakeoverCertState }>;
}

/** A takeover of one server. Secret-free. `giveBackAvailable` stays true until the cleanup lane removes Coolify's leftovers. */
export interface TakeoverView {
  id: string;
  serverId: string;
  status: TakeoverStatus;
  tempPort: number | null;
  items: TakeoverItemView[];
  giveBackAvailable: boolean;
  createdAt: string;
  finishedAt: string | null;
}

// ── cleanup and completeness (lane G) ──────────────────────────────────────────────────────────────

export const CLEANUP_STATUSES = ["CHECKING", "INCOMPLETE", "READY", "CLEANING", "CLEANED", "FAILED"] as const;
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

/** The things compared one by one between Coolify and Tugra. */
export const COMPLETENESS_KINDS = ["application", "database", "service", "domain", "env_keys", "volume", "scheduled_task", "backup", "notification"] as const;
export type CompletenessKind = (typeof COMPLETENESS_KINDS)[number];

export interface CompletenessRow {
  kind: CompletenessKind;
  coolify: number;
  tugra: number;
  /** Refs present in Coolify and missing in Tugra (names/refs only). */
  missing: string[];
}

/** What Coolify left on a server. Names and sizes; the owner confirms before anything is removed. */
export const REMNANT_KINDS = ["container", "network", "image", "directory"] as const;
export type RemnantKind = (typeof REMNANT_KINDS)[number];
export interface CleanupRemnant {
  kind: RemnantKind;
  name: string;
  sizeBytes: number | null;
}

export interface CleanupView {
  id: string;
  serverId: string;
  status: CleanupStatus;
  completeness: CompletenessRow[];
  remnants: CleanupRemnant[];
  confirmedAt: string | null;
  cleanedAt: string | null;
}

// ── project move inside Tugra (lane H) ─────────────────────────────────────────────────────────────

export const PROJECT_MOVE_PHASES = ["QUEUED", "PRECHECK", "MOVING", "VERIFYING", "CUTOVER", "COMPLETED", "ROLLING_BACK", "ROLLED_BACK", "FAILED"] as const;
export type ProjectMovePhase = (typeof PROJECT_MOVE_PHASES)[number];

export type ProjectMoveItemKind = "application" | "database" | "service";

/** One member of the move. `childId` is the id of the AppMove (or database move) that carries it. */
export interface ProjectMoveItemView {
  kind: ProjectMoveItemKind;
  refId: string;
  name: string;
  childId: string | null;
  phase: string;
}

export interface ProjectMoveRequest {
  projectId: string;
  targetServerId: string;
  /** Days the source copy is kept as a safety copy (default 7). */
  retainDays?: number;
  repointDns?: boolean;
}

export interface ProjectMoveView {
  id: string;
  projectId: string;
  sourceServerId: string;
  targetServerId: string;
  phase: ProjectMovePhase;
  items: ProjectMoveItemView[];
  retainDays: number;
  archiveUntil: string | null;
  createdAt: string;
  finishedAt: string | null;
}
