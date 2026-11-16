/**
 * The port the import-side steps (PREFLIGHT, IMPORT, REMAP_ENV, DEPLOY_DARK) use to reach the existing importer, the apps
 * and databases services and the target server. One production adapter (`import-port.service.ts`) binds it to the real
 * services; `testing/run-world.ts` ships a scripted fake. Every method is called AS the run's actor and re-checks
 * permissions in the service it wraps.
 */
import type { ImportApplyInput, ImportMappingResolveInput, RemoteSourceKind, ServiceChoice } from "../../../importer/dto";
import type { ImportPlanResponse } from "../../../importer/importer.service";
import type { ResolvedMapping } from "../../../importer/import-mapping";
import type { ServicePreview } from "../../../importer/service-preview";
import type { RollbackOptions } from "../../../importer/import-executor.service";
import type { RunImportPort } from "../../core/run-ports";

/** Nest token of the {@link ImportStepsPort} (the same adapter also serves the core's {@link RunImportPort} token). */
export const IMPORT_STEPS_PORT = Symbol("MIGRATION_RUN_IMPORT_STEPS");

export type SessionState = "active" | "expired" | "missing";

/** One task of an import op as the steps see it (secret-free: ids, names, statuses). */
export interface OpTask {
  itemRef: string | null;
  kind: string;
  status: string;
  resourceType: string | null;
  resourceId: string | null;
  name: string | null;
  /** Git link outcome of a git app (`needs_source`, `linked`, ...). */
  gitStatus: string | null;
}

/** The import op the run currently points at. */
export interface OpSnapshot {
  id: string;
  /** `meta.rolledBackAt` is set: the op's resources were torn down. */
  rolledBack: boolean;
  cancelRequested: boolean;
  tasks: OpTask[];
  /** The plan captured at apply time: itemRef -> the items it depends on (a stateless app has none). */
  planItems: Array<{ itemRef: string; kind: string; dependsOn: string[] }>;
}

export interface RemapSummary {
  /** The 64-hex confirm token of the reviewed preview. */
  planHash: string;
  /** Apps with at least one automatic rewrite. */
  appsToWrite: number;
  /** Variables that need a manual remap (apps x keys). */
  needsManualKeys: number;
  needsManualApps: number;
}

export interface RemapApplyResult {
  applied: boolean;
  failed: number;
  linkFailed: number;
}

export interface DeploymentRef {
  id: string;
  key: string;
  status: string;
  trigger: string | null;
  requestedBy: string | null;
}

export interface ResourceState {
  exists: boolean;
  /** `AppStatus` (NEW|RUNNING|STOPPED|FAILED) or `DbStatus` (NEW|PROVISIONING|RUNNING|STOPPED|FAILED). */
  status: string;
  name: string | null;
}

/** What PREFLIGHT knows about the target server (read-only). */
export interface TargetFacts {
  serverName: string;
  agentOnline: boolean;
  capabilities: string[];
  /** The proxy's ACME email is a real address (a placeholder counts as not ok). */
  acmeEmailOk: boolean;
  proxyBind: string | null;
  /** A usable team DNS credential exists (pinned or the server's own). */
  dnsCredential: boolean;
  /** Per primary host: the Cloudflare zone coverage and SSL mode (empty when no credential). */
  zones: Array<{ host: string; zone: string | null; sslMode: string | null; lookupFailed: boolean }>;
}

export interface ImportStepsPort extends RunImportPort {
  sessionState(userId: string, sessionId: string | null): Promise<SessionState>;
  /** Re-discover + plan with the session. READ-ONLY (memoized for a short while): writes nothing, not even `lastUsedAt`. */
  plan(userId: string, input: { sessionId: string; sourceKind: RemoteSourceKind; dbDataModes?: Record<string, "volume"> }): Promise<ImportPlanResponse>;
  resolveMapping(userId: string, input: ImportMappingResolveInput): Promise<ResolvedMapping>;
  /** A non-empty saved mapping exists for the session's source scope (the apply then demands the mapping explicitly). */
  storedMappingExists(userId: string, sessionId: string): Promise<boolean>;
  previewServices(userId: string, input: { sessionId: string; sourceKind: RemoteSourceKind; choices?: Record<string, ServiceChoice> }): Promise<ServicePreview[]>;
  target(userId: string, input: { serverId: string; dnsCredentialId?: string; hosts: readonly string[] }): Promise<TargetFacts>;

  // ── IMPORT ──
  apply(userId: string, input: ImportApplyInput): Promise<{ opId: string }>;
  opSnapshot(userId: string, opId: string): Promise<OpSnapshot>;
  /** Import ops of this actor on the server created at or after `since` (finds an op whose apply crashed before it was recorded). */
  opsSince(userId: string, serverId: string, since: Date): Promise<string[]>;
  cancelOp(userId: string, opId: string): Promise<void>;
  rollbackOp(userId: string, opId: string, opts: RollbackOptions): Promise<void>;

  // ── REMAP_ENV ──
  remapPending(userId: string, opId: string): Promise<boolean>;
  remapPlan(userId: string, opId: string): Promise<RemapSummary>;
  remapApply(userId: string, opId: string, confirmToken: string): Promise<RemapApplyResult>;
  /** Revert the applied remap; `true` when nothing remains pending (a transient per-app failure returns false). */
  remapUndo(userId: string, opId: string): Promise<boolean>;

  // ── DEPLOY_DARK ──
  appState(userId: string, appId: string): Promise<ResourceState>;
  dbState(userId: string, dbId: string): Promise<ResourceState>;
  startDb(userId: string, dbId: string): Promise<ResourceState>;
  stopDb(userId: string, dbId: string): Promise<void>;
  stopApp(userId: string, appId: string): Promise<void>;
  /** The run's deployments of an app (idempotency key `migrun:<runId>:<appId>` plus retry suffixes), oldest first. */
  deployments(appId: string, keyPrefix: string): Promise<DeploymentRef[]>;
  /** Cancel a QUEUED deployment (or ask a running one to stop); throws when it can no longer be cancelled. */
  cancelDeployment(userId: string, appId: string, deploymentId: string): Promise<void>;
  /** Enqueue + run a deploy under the idempotency key (the finished/queued row). */
  deploy(userId: string, appId: string, key: string): Promise<DeploymentRef | null>;
}
