import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { MigratorService } from "../migrator/migrator.service";
import { ApplicationsService } from "../applications/applications.service";
import { DatabasesService } from "../databases/databases.service";
import { CryptoService } from "../crypto/crypto.service";
import { GitSourcesService } from "../git-sources/git-sources.service";
import { GitLinkResolverService, type GitLinkRow } from "./git-link-resolver.service";
import { ProjectsService } from "../projects/projects.service";
import type { CreateDatabaseInput } from "../databases/dto";
import { ImporterService } from "./importer.service";
import { LocalDockerSource } from "./sources/local-docker.source";
import { planImport, ns, ENV_RISK_UNRESOLVED, ENV_RISK_INVALID } from "./import-planner";
import { isValidUserEnvKey } from "../common/env-key";
import { mapSourceEnvFlags } from "./env-auto-flags";
import { mapBuildPack } from "./buildpack-map";
import { IMPORT_REASON_CODES, type ImportReasonCode } from "@tugra/shared";
import { why, type Reasoned, type Unmapped } from "./reason";
import { foreignAppToCreateInput, foreignAppToIngressPlan, foreignAppToPostCreateConfig, foreignAppToVolumes } from "./apply-map";
import { seedTasks, deriveOpStatus, isAcked, isRunnable, skipReason, hasUnackedBlocker, type TaskSeed, type TaskStatus } from "./import-executor.logic";
import { MigrationTokenService } from "./migration-token.service";
import { assertSafeBase, buildMigrationCommand, buildMigrationCommands, buildMigrationCommandsTemplate, buildMigrationCommandTemplate } from "./migration-command";
import { cleanupOpStaging } from "./migration-staging";
import type { ForeignApp, ForeignDb, ForeignFleet, ForeignGitProvider, ForeignService, ServiceBundle } from "./foreign-fleet";
import { transformServiceCompose, type ServiceTransformResult } from "./import-service-map";
import { buildServiceChecklist, type ChecklistItem } from "./service-checklist";
import { validateServiceChoices } from "./service-choices";
import { generatedOnlyTemplate } from "../templates/catalog";
import { composeProject } from "../deploy/compose-script";
import { createHash } from "node:crypto";
import { remapEnv, credsFromUrlForHost, type DbRemapTarget, type AppRemapTarget } from "./env-rewrite";
import { tokenizeDockerOptions } from "../deploy/deploy-script";
import type { DatabaseView } from "../databases/databases.service";

import { SetBasicAuthSchema } from "../applications/dto";
import type { ImportSource, FetchedDbCredentials, SourceAppExtras } from "./import-source";
import { REMOTE_SOURCE_KINDS, type ImportApplyInput, type RemoteSourceKind, type ServiceChoice } from "./dto";
import { ImportMappingService } from "./import-mapping.service";
import type { EffectiveItem, ResolvedMapping } from "./import-mapping";
import { slug as dbSlug } from "../databases/databases.service";
import { VX_DATA_PREFIX, isVxDataTask, vxEnabled } from "./volume-stream/vx-constants";
import { VxApplyService } from "./volume-stream/vx-apply.service";

const CONCURRENCY = 5;

const STALE_RUNNING_MS = 10 * 60_000; // a RUNNING task older than this is treated as a dead worker's leftover
/** Source kinds that create FRESH Tugra resources (copy-mode): rollback REMOVES them, and only these may
 *  migrate data. local-docker is NOT here — it adopts live containers in place (rollback un-adopts). */
const COPY_MODE_KINDS = new Set<string>(REMOTE_SOURCE_KINDS);

/** The env-remap host-shape gate per source. Dokploy internal hosts are the resource `appName` (e.g.
 *  `diesdigital-db-58tvyg`: hyphens/underscores, not uuid-shaped). Coolify/local-docker pass NOTHING so the
 *  engine's uuid default applies and their output stays byte-identical. The shape only gates which bare
 *  values are considered a host; a rewrite still requires an exact match to a known oldHost. */
export const DOKPLOY_HOST_SHAPE = /^[a-z0-9][a-z0-9_-]{5,62}$/i;
const remapHostShapeFor = (sourceKind: string | undefined): RegExp | undefined => (sourceKind === "dokploy" ? DOKPLOY_HOST_SHAPE : undefined);
/** A DB_IDENT_RE-safe database name derived from a display name (fallback when the source has no database name). */
const safeDbIdent = (name: string): string => name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63) || "app";
const msg = (e: unknown): string => (e instanceof Error ? e.message : "failed");
/** The private network a single-service import joins: `svc-<app name slug>` (a DNS label, at most 63 chars), or undefined. */
function privateNetworkName(appName: string): string | undefined {
  const slug = appName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 58).replace(/-+$/g, "");
  return slug ? `svc-${slug}` : undefined;
}

/** Sources whose variables are imported STRICTLY: an unresolved/invalid key blocks (ackably) instead of being
 *  silently dropped. Dokploy/local keep their lenient behaviour (byte-identical). */
const STRICT_ENV_KINDS = new Set<string>(["coolify"]);

export { isAcked };

/**
 * Opt-in extensions of {@link ImportExecutorService.rollback} for a RUN-owned import (P7 guided migration). Absent = the
 * original behaviour, byte for byte.
 */
export interface RollbackOptions {
  /**
   * Deployments whose idempotency key starts with `migrun:<runId>:` were created by this run's DEPLOY_DARK step, not by a
   * person: they no longer count as "redeployed since import", so those apps are torn down like never-deployed ones.
   */
  runOwnedDeployments?: { runId: string };
  /**
   * Also remove DATA-BEARING resources (an app whose volume data was restored, a database that was started, restored or
   * backed up) - but only those whose exact display name is listed in `dataConfirmNames` (typed by the operator).
   */
  includeData?: boolean;
  dataConfirmNames?: readonly string[];
}

/** "KEY1, KEY2 (+M more)" — names only, never values. */
const keyList = (keys: string[], cap: number): string => (keys.length > cap ? `${keys.slice(0, cap).join(", ")} (+${keys.length - cap} more)` : keys.join(", "));

/**
 * Applies an import plan, persisted as a BulkOperation(kind="import") with one typed task per plan item so
 * progress survives the request and can be polled, cancelled, or rolled back. Two modes:
 *  - local-docker: in-place ADOPTION via {@link MigratorService.adopt} (re-inspects + renames under Tugra).
 *  - coolify: COPY-mode — each app is created fresh on a target server from its resolved spec + secrets,
 *    and each database is provisioned as an empty resource (its DATA is restored later by the migrator).
 * Volume items are still recorded as skipped (they are declared on / restored with their owner). No secret
 * VALUES are ever stored on a task or returned.
 */
@Injectable()
export class ImportExecutorService {
  private readonly logger = new Logger(ImportExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly migrator: MigratorService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly importer: ImporterService,
    private readonly apps: ApplicationsService,
    private readonly dbs: DatabasesService,
    private readonly migrationTokens: MigrationTokenService,
    private readonly crypto: CryptoService,
    private readonly gitSources: GitSourcesService,
    private readonly projects: ProjectsService,
    private readonly gitLinkResolver: GitLinkResolverService,
    // Trailing + optional: the mapping-free construction (and every pre-existing spec) is unchanged.
    private readonly mappings?: ImportMappingService,
    @Optional() private readonly vxApply?: VxApplyService,
  ) {}

  apply(userId: string, input: ImportApplyInput): Promise<{ opId: string; mappingApplied?: boolean }> {
    return input.sourceKind === "local-docker" ? this.applyLocalDocker(userId, input) : this.applyRemote(userId, input);
  }

  /** Re-discover + re-plan, enforce the reviewed plan via planHash, then persist + fan out the adoptions. */
  private async applyLocalDocker(userId: string, input: Extract<ImportApplyInput, { sourceKind: "local-docker" }>): Promise<{ opId: string }> {
    const source = new LocalDockerSource(this.migrator, userId, input.serverId);
    const fleet = await source.discover(); // enforces apps:config + blanks env values
    const plan = planImport(fleet, { sourceKind: "local-docker", targetServerId: input.serverId });
    if (plan.planHash !== input.planHash) {
      throw new ConflictException("the plan changed since it was previewed — re-run the plan and review again");
    }
    await this.assertNoInflight(input.serverId);
    const seeds = seedTasks(plan, fleet);
    const op = await this.createOp(userId, "local-docker", input.serverId, plan.planHash, { plan });

    const byId = new Map<string, TaskSeed>();
    for (const s of seeds) {
      const task = await this.prisma.bulkTask.create({
        data: {
          opId: op.id,
          serverId: input.serverId,
          kind: s.kind,
          itemRef: s.itemRef,
          status: s.run ? "PENDING" : "SKIPPED",
          dependsOn: s.dependsOn,
          output: s.run ? null : s.skipReason,
          result: { name: s.name }, // the proposed/source name — secret-free; merged with appId on success
          compensation: s.adopt ? { originalName: s.adopt.originalName } : undefined,
        },
      });
      if (s.run && s.adopt) byId.set(task.id, s);
    }
    await this.audit.log({ actor: userId, action: "import.apply", target: op.id, meta: { sourceKind: "local-docker", serverId: input.serverId, run: byId.size, total: seeds.length } });
    void this.fanout(op.id, [...byId.keys()], (taskId) => this.runAdopt(taskId, input.serverId, userId, byId.get(taskId)!)).catch(() => undefined);
    return { opId: op.id };
  }

  /** Copy a remote fleet's apps onto a target Tugra server: per app, resolve its secrets and create it. */
  private async applyRemote(userId: string, input: Extract<ImportApplyInput, { sourceKind: RemoteSourceKind }>): Promise<{ opId: string; mappingApplied: boolean }> {
    const { source, session } = await this.importer.openSession(userId, input.sessionId, input.sourceKind); // session ownership + team authz + kind pin
    try {
      const fleet = await source.discover();
      const plan = planImport(fleet, { sourceKind: input.sourceKind, ...(input.dbDataModes && Object.keys(input.dbDataModes).length ? { dbDataModes: input.dbDataModes } : {}) });
      if (plan.planHash !== input.planHash) {
        throw new ConflictException("the plan changed since it was previewed — re-run the plan and review again");
      }
      // Per-service choices are validated against the FRESHLY re-planned service items: an unknown itemRef, volume key or
      // member name is a 400 BEFORE any op or task row is written (a choice can only narrow or rename, never add).
      const serviceChoices = validateServiceChoices(fleet, plan.items, input.serviceChoices);
      // Authorize the TARGET server up front (fail fast with 403/404, before taking the per-server lock or
      // writing any op/task rows) — openSession only vouches for the session's team, not the import target.
      const server = await this.prisma.server.findUnique({ where: { id: input.targetServerId } });
      if (!server) throw new NotFoundException("target server not found");
      await this.access.requirePermission(userId, server.teamId, "apps:config");
      await this.assertNoInflight(input.targetServerId);
      // A service may be placed on a different server by its choice: each distinct target is re-authorised (same team as
      // the op) and gets its own in-flight check.
      const svcTargets = await this.authorizeServiceTargets(userId, server.teamId, input.targetServerId, serviceChoices);

      // Editable mapping: resolve + validate BEFORE anything is created (fail closed — a refusal here has created
      // nothing: no git source, no project, no op row). `res` is undefined on the legacy no-mapping path, which
      // then follows the original code byte-identically.
      const res = this.mappings
        ? await this.mappings.resolveForApply(userId, session, fleet, plan, server, {
            mapping: input.mapping,
            mappingHash: input.mappingHash,
            reconcile: input.reconcile,
            ignoreStoredMapping: input.ignoreStoredMapping,
            environmentId: input.environmentId,
            acks: input.acks,
          })
        : undefined;
      const effByRef = new Map((res?.effective ?? []).map((e) => [e.itemRef, e]));
      const gitNameByRef = res ? new Map(res.gitSources.map((g) => [g.ref, g.name])) : undefined;

      // Carry each discovered GitHub App into a Tugra GitSource on the TARGET team (credentials flow
      // source → memory → GitSourcesService, encrypted at rest; never a task/plan/log). Done BEFORE the op row so
      // any skipped-provider warning is persisted with it; per-provider failures degrade, never abort the import.
      const { gitSourceByRef, warnings: providerWarnings } = await this.carryGitProviders(userId, server.teamId, source, fleet.gitProviders ?? [], gitNameByRef);

      // Repo-visibility link resolution (D7): per git app, which connected source can actually see the repo. Computed
      // ONCE here (before the op row, so a failure note persists with it). A resolver failure degrades to "no links":
      // the apps are created unlinked and the task notes say so; it never aborts the import and never guesses.
      let gitLinks: ReadonlyMap<string, GitLinkRow> = new Map();
      try {
        gitLinks = await this.gitLinkResolver.resolve(server.teamId, fleet.apps);
      } catch {
        providerWarnings.push("git: repository visibility could not be checked - git apps are created unlinked; link them afterwards from the import timeline");
      }

      // Mirror the source's project → environment tree on the TARGET team (find-or-create by name, so a re-import
      // reuses it). Also before the op row, so the created names + any degrade warning persist with it. A source
      // with no tree (Coolify) skips this and keeps the single input.environmentId.
      // Under a mapping the tree is built from the RESOLVED groups instead (only the projects/environments a
      // runnable item uses; a failure is a hard error, never a silent degrade — perm.projects was checked).
      const tree = res ? await this.buildMappedTree(userId, server.teamId, fleet, res, input.mapping?.projects ?? {}) : await this.buildImportTree(userId, server.teamId, fleet);
      const opWarnings = [
        ...providerWarnings,
        ...tree.warnings,
        ...(res?.conflicts.some((c) => c.code === "gitsource.exists_not_renamed") ? ["a git source for a GitHub App already exists on the target team — its name was kept (a rename applies on create only)"] : []),
      ];

      const op = await this.createOp(userId, input.sourceKind, input.targetServerId, plan.planHash, {
        sessionId: input.sessionId,
        plan,
        ...(opWarnings.length ? { warnings: opWarnings } : {}),
        ...(tree.summary.length ? { projects: tree.summary } : {}),
        // Audit trail of what the operator acknowledged (codes + itemRefs only — never a variable name or value).
        ...(input.acks?.length ? { acks: input.acks } : {}),
        // Coolify services (uuid + name only) so the env-remap preview can flag a value that still points at an old
        // service host (e.g. MinIO) instead of leaving it silently unchanged. Not a secret.
        ...(input.sourceKind === "coolify" && fleet.services.length
          ? { services: fleet.services.map((sv) => ({ itemRef: ns("service", sv.serverRef, sv.sourceRef), name: sv.name.slice(0, 120), oldHost: sv.sourceRef })) }
          : {}),
        // Secret-free: names, hostnames, volume policies. Never a value.
        ...(Object.keys(serviceChoices).length ? { serviceChoices } : {}),
        ...(res ? { mapping: mappingSnapshot(res, input.reconcile === true) } : {}),
      });
      // Idempotency: skip app refs a prior op already imported onto this target (and whose app still exists),
      // so a re-apply after a partial/cancelled run does not create duplicate Tugra apps.
      const already = await this.alreadyImported(input.targetServerId, plan.items.map((i) => i.itemRef), op.id);

      const svcByRef = new Map(fleet.services.map((sv) => [ns("service", sv.serverRef, sv.sourceRef), sv]));
      // Idempotency per placement target: a service placed on another server is matched against THAT server's prior imports.
      const alreadyOnTarget = new Map<string, Set<string>>([[input.targetServerId, already]]);
      for (const t of svcTargets) {
        if (alreadyOnTarget.has(t)) continue;
        alreadyOnTarget.set(t, await this.alreadyImported(t, plan.items.filter((i) => i.kind === "service").map((i) => i.itemRef), op.id));
      }
      const appByRef = new Map(fleet.apps.map((a) => [`app:${a.serverRef ?? "_"}:${a.sourceRef}`, a]));
      const dbByRef = new Map(fleet.databases.map((d) => [`database:${d.serverRef ?? "_"}:${d.sourceRef}`, d]));
      // Per task, the exact work to run. Apps are copied; databases are provisioned as empty resources
      // (their DATA is restored later by the migrator) so a destResourceId exists to restore INTO.
      // Volume items stay SKIPPED here — a volume is DECLARED (empty) inside its owning app's task; its DATA
      // is not copied by this import yet.
      const runners = new Map<string, () => Promise<void>>();
      const reconcile = input.reconcile === true;
      for (const item of plan.items) {
        const app = item.kind === "app" ? appByRef.get(item.itemRef) : undefined;
        const db = item.kind === "database" ? dbByRef.get(item.itemRef) : undefined;
        const service = item.kind === "service" ? svcByRef.get(item.itemRef) : undefined;
        const choice = item.kind === "service" ? serviceChoices[item.itemRef] : undefined;
        // targetFor(item): the service choice's own target, else the op target (the serverMap lane is not in this slice).
        const targetServerId = choice?.targetServerId ?? input.targetServerId;
        const dup = (alreadyOnTarget.get(targetServerId) ?? already).has(item.itemRef);
        const hasBlocker = hasUnackedBlocker(item, input.acks);
        const serviceRunnable = !!service && !choice?.skip && item.proposed.verdict !== "skipped" && typeof service.composeFile === "string" && typeof source.fetchServiceBundle === "function";
        const eff = effByRef.get(item.itemRef); // set only under a mapping
        const excluded = !!eff && !eff.include;
        // An already-imported item with mapped drift is reconciled ONLY behind the explicit flag; its task is
        // SKIPPED at the end (never DONE), so rollback and the idempotency scan stay blind to it.
        const reconciles = !!eff && dup && !excluded && reconcile && !!eff.drift?.length;
        // App/database items use the exact predicate the mapping resolver previews with; the service branch is local.
        const runnable = !excluded && (isRunnable(item, app, db, dup, input.acks) || (item.kind === "service" && !dup && !hasBlocker && serviceRunnable));
        const baseReason =
          item.kind === "service" && !dup && !hasBlocker
            ? choice?.skip
              ? "skipped by your choice"
              : item.proposed.verdict === "skipped"
                ? "this service is not imported (see its plan note)"
                : "this source cannot read the service's variables"
            : skipReason(item, db, dup, input.acks);
        const reason = excluded
          ? "excluded by mapping"
          : eff && dup && eff.drift?.length && !reconcile
            ? `${baseReason}; mapping not applied (${eff.drift.join(", ")}) — enable reconcile`
            : baseReason;
        const task = await this.prisma.bulkTask.create({
          data: {
            opId: op.id,
            serverId: targetServerId,
            kind: item.kind,
            itemRef: item.itemRef,
            status: runnable || reconciles ? "PENDING" : "SKIPPED",
            dependsOn: item.dependsOn,
            output: runnable || reconciles ? null : reason,
            result: eff ? { name: eff.name, sourceName: item.name, mapped: true } : { name: item.name },
          },
        });
        // The resource's own source environment when the tree resolved it; else the single selected environment.
        // Under a mapping the resolved (project, environment) of THIS item wins.
        const environmentId = (item.kind === "service" ? choice?.environmentId : undefined) ?? tree.envByItemRef?.get(item.itemRef) ?? resolveTreeEnvironment(tree.envByRef, app ?? db) ?? input.environmentId;
        // Ack codes that actually cover a risk THIS item carries (an ack for a code the plan never raised for it grants nothing).
        const ackedCodes = new Set(item.risks.filter((r) => isAcked(input.acks, item.itemRef, r.code)).map((r) => r.code));
        if (reconciles && eff) runners.set(task.id, () => this.runReconcile(task.id, userId, eff, tree.envByItemRef?.get(item.itemRef)));
        else if (runnable && service) runners.set(task.id, () => this.runCopyService(task.id, source, service, userId, targetServerId, input.sourceKind, environmentId, choice));
        else if (runnable && app) runners.set(task.id, () => this.runCopyApp(task.id, source, app, userId, input.targetServerId, input.sourceKind, environmentId, gitSourceByRef, ackedCodes, gitLinks, eff));
        else if (runnable && db) runners.set(task.id, () => this.runCreateDb(task.id, source, db, userId, input.targetServerId, environmentId, eff));
      }
      await this.audit.log({
        actor: userId,
        action: "import.apply",
        target: op.id,
        meta: { sourceKind: input.sourceKind, serverId: input.targetServerId, run: runners.size, total: plan.items.length, ...(res ? { mappingHash: res.mappingHash, ...res.counts, reconcile } : {}) },
      });
      void this.fanout(op.id, [...runners.keys()], (taskId) => runners.get(taskId)!())
        .catch(() => undefined)
        .finally(() => source.close()); // close only once the async fan-out is done with the client
      // The op row exists: keep the applied mapping as the editable profile for the next run (best effort).
      if (res && input.mapping && input.saveMapping !== false) await this.mappings!.markApplied(userId, session, op.id, input.mapping);
      return { opId: op.id, mappingApplied: !!res };
    } catch (e) {
      // Any failure before the fan-out is handed the source → close it here (the fan-out's finally won't run).
      await source.close();
      throw e;
    }
  }

  /** Authorise every distinct placement target a service choice names: it must exist, belong to the SAME team as the op's
   *  target, grant the actor `apps:config`, and have no import in flight. Returns the distinct extra targets. */
  private async authorizeServiceTargets(userId: string, teamId: string, opTarget: string, choices: Record<string, ServiceChoice>): Promise<string[]> {
    const targets = [...new Set(Object.values(choices).map((c) => c.targetServerId).filter((t): t is string => !!t && t !== opTarget))].sort();
    for (const t of targets) {
      const srv = await this.prisma.server.findUnique({ where: { id: t } });
      if (!srv) throw new NotFoundException("target server not found");
      if (srv.teamId !== teamId) throw new ForbiddenException("a service target must be in the same team as the import target");
      await this.access.requirePermission(userId, srv.teamId, "apps:config");
      await this.assertNoInflight(t);
    }
    return targets;
  }

  /**
   * Copy ONE Coolify service onto the target as a STOPPED Tugra compose app. The source's own raw compose is rewritten by the
   * pure transform; secrets are carried (never regenerated); nothing is deployed. Order matters:
   *  1. everything that can fail the item is decided BEFORE anything is created (secrets, safety gate, config files, name),
   *     so a retry can never duplicate an app;
   *  2. once the app exists, every further step is best-effort with its own try/catch and a FIXED note (the orphan-app rule).
   * Task rows, audit rows and logs carry names and counts only, never a value or a file's content.
   */
  private async runCopyService(taskId: string, source: ImportSource, svc: ForeignService, userId: string, targetServerId: string, sourceKind: RemoteSourceKind, environmentId: string | undefined, choice: ServiceChoice | undefined): Promise<void> {
    if (!(await this.claim(taskId))) return;
    const fail = (output: string) => this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "FAILED", output, finishedAt: new Date() } });
    try {
      // 1. Secrets + files (server-side only). A source that throws is a FIXED message (a client error can echo a body).
      let bundle: ServiceBundle | undefined;
      try {
        bundle = await source.fetchServiceBundle?.(svc.sourceRef);
      } catch {
        await fail("service variables could not be read from the source — retry the import");
        return;
      }
      const res = transformServiceCompose({ svc, raw: svc.composeFile ?? "", bundle: { values: bundle?.values ?? {}, files: bundle?.files }, choice });
      if (res.gate !== "ok") {
        await fail(`the compose is refused by the safety gate (${res.gate.code}) — it is never carried or overridden`);
        return;
      }
      if (res.verdict === "skipped" && res.neededFiles.length === 0) {
        await fail("this service has nothing Tugra can import");
        return;
      }
      if (res.missingEnv.length) {
        await fail(`service secrets unavailable — the Coolify token needs read:sensitive (missing: ${res.missingEnv.slice(0, 10).join(", ")}${res.missingEnv.length > 10 ? ", …" : ""})`);
        return;
      }
      if (res.neededFiles.length) {
        await fail(`config files are needed from the source and could not be read (${res.neededFiles.slice(0, 10).join(", ")})`);
        return;
      }
      // 2. Name: the source's own (or the operator's). A clash is a hard failure, never an auto-suffix.
      const name = choice?.name ?? svc.name;
      const server = await this.prisma.server.findUnique({ where: { id: targetServerId }, select: { teamId: true, publicIp: true } });
      if (!server) {
        await fail("target server not found");
        return;
      }
      const clash = await this.prisma.application.findFirst({ where: { teamId: server.teamId, name }, select: { id: true } });
      if (clash) {
        await fail("an app with this name already exists — rename it in the import screen");
        return;
      }
      // 3. Create: a synthetic compose ForeignApp through the SAME mapper every import uses. serviceImport leaves the domain
      //    unset and exposeMode none. deploy:false, tags imported + coolify-service. The template link is logo/search only.
      const domainRows = res.domains.map((d) => ({ host: d.hostname, https: true, port: d.port, serviceRef: d.service, primary: false }));
      const synthetic: ForeignApp = { sourceRef: svc.sourceRef, name, kind: "compose", buildPack: "dockercompose", composeFile: res.compose, domains: domainRows };
      const mappedFlags = mapSourceEnvFlags(res.env, bundle?.flags, "COMPOSE");
      const tpl = svc.templateSlug && generatedOnlyTemplate(svc.templateSlug) && !generatedOnlyTemplate(svc.templateSlug)!.web ? svc.templateSlug : undefined;
      const createInput = foreignAppToCreateInput(synthetic, res.env, { serverId: targetServerId, environmentId, sourceTag: "coolify-service", serviceImport: true, templateSlug: tpl }, bundle?.flags, mappedFlags);
      const created = await this.apps.create(userId, createInput); // re-checks apps:config on the TARGET team and the safety gate

      // 4. Best-effort steps, each in its own try/catch (FIXED notes, never the error text).
      const unmapped: Array<{ field: string; reason: string }> = [];
      const steps: Array<{ name: string; status: string }> = [{ name: "prepare", status: "DONE" }, { name: "create", status: "DONE" }];
      const domains = { applied: 0, unmapped: [] as Array<{ field: string; reason: string }> };
      try {
        const plan = foreignAppToIngressPlan(synthetic, { noPrimary: true });
        domains.unmapped.push(...plan.unmapped);
        if (plan.serviceDomains.length) {
          await this.apps.setServiceDomains(userId, created.id, plan.serviceDomains);
          domains.applied = plan.serviceDomains.length;
        }
        steps.push({ name: "domains", status: "DONE" });
      } catch {
        domains.unmapped.push({ field: "serviceDomains", reason: "Tugra rejected the service domains — set them in the app's domain settings" });
        steps.push({ name: "domains", status: "FAILED" });
      }
      let configMounts = 0;
      if (res.configMounts.length) {
        try {
          await this.apps.setConfigMountsForImport(userId, created.id, res.configMounts);
          configMounts = res.configMounts.length;
          steps.push({ name: "config-files", status: "DONE" });
        } catch {
          unmapped.push({ field: "configMounts", reason: "Tugra rejected the config files — add them in the app's config files" });
          steps.push({ name: "config-files", status: "FAILED" });
        }
      }
      // D2 = B: an internal-only single-service stack stays PRIVATE: it joins a hub-owned network under a stable alias, so
      // dependents attach to it instead of a public Traefik domain. Never a public domain, never auto-wired to dependents.
      let network: { network: string; alias: string } | undefined;
      const internalOnly = res.domains.length === 0 && !res.hold && res.membersKept.length === 1;
      if (internalOnly && choice?.privateNetwork !== false) {
        const member = res.membersKept[0];
        const net = privateNetworkName(name);
        const alias = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(member) && member.length <= 63 && !/^tugra[-_]/i.test(member) ? member : undefined;
        try {
          if (!net || !alias) throw new Error("no usable network name");
          await this.apps.setComposeNetworks(userId, created.id, [{ network: net, service: member, aliases: [alias] }]);
          network = { network: net, alias };
        } catch {
          unmapped.push({ field: "composeNetworks", reason: "the private network could not be set up — attach it in the app's network settings" });
        }
      }
      steps.push({ name: "volumes", status: res.volumes.length ? "PENDING_DATA" : "SKIPPED" }, { name: "done", status: "DONE" });

      const outcome = { network, targetIp: server.publicIp ?? undefined };
      const checklist: ChecklistItem[] = buildServiceChecklist(svc, res, choice, outcome);
      const result = {
        kind: "service",
        name: created.name,
        appId: created.id,
        members: res.membersKept,
        dropped: res.dropped.map((d) => ({ field: d.field, reason: d.reason })),
        configMounts,
        unresolvedEnv: bundle?.unresolved.length ?? 0,
        serviceDomains: domains,
        ...(network ? { privateNetwork: network } : {}),
        volumes: res.volumes.map((v) => ({ key: v.key, dockerName: `${composeProject({ id: created.id })}_${v.key}`, policy: v.policy, dataPlane: v.dataPlane, state: "pending-data" })),
        hold: res.hold,
        checklist,
      };
      const notes = [domains.unmapped.length ? `domains not carried: ${domains.unmapped.map((u) => u.field).join(", ")}` : undefined, unmapped.length ? `not carried: ${unmapped.map((u) => u.field).join(", ")}` : undefined, mappedFlags.warnings.length ? `env flags not carried: ${mappedFlags.warnings.join("; ")}` : undefined].filter(Boolean).join("; ");
      await this.prisma.bulkTask.update({
        where: { id: taskId },
        data: {
          status: "DONE",
          resourceType: "application",
          resourceId: created.id,
          result: { ...result, ...(unmapped.length ? { unmapped } : {}) } as unknown as Prisma.InputJsonValue,
          steps,
          ...(notes ? { output: notes } : {}),
          finishedAt: new Date(),
        },
      });
      await this.audit.log({ actor: userId, action: "import.service.copy", target: created.id, meta: { name: created.name, members: res.membersKept.length, volumes: res.volumes.length, configMounts, unresolvedEnv: bundle?.unresolved.length ?? 0 } });
    } catch (e) {
      // A create failure surfaces our own (validation/gate) message; anything else is a FIXED text (a Prisma/transport error can echo data).
      await fail(e instanceof HttpException ? msg(e).slice(0, 300) : "the service could not be created");
    }
  }

  /**
   * Build the target project/environment tree for a fleet that carries one (Dokploy): per source project,
   * {@link ProjectsService.findOrCreateForImport} (idempotent by name) → projectRef → (environmentRef → Tugra
   * environmentId). Per-project failures (e.g. the caller lacks `projects` on the target team) DEGRADE: that
   * project's resources simply stay on the selected environment and a FIXED warning (never an error message) is
   * recorded. `summary` holds names only (no ids of secrets, no values) for op.meta.
   */
  private async buildImportTree(userId: string, teamId: string, fleet: ForeignFleet): Promise<ImportTree> {
    const tree: ImportTree = { envByRef: new Map(), summary: [], warnings: [] };
    for (const p of fleet.projects ?? []) {
      try {
        const r = await this.projects.findOrCreateForImport(userId, teamId, {
          name: p.name,
          description: p.description,
          tags: p.tags,
          environments: p.environments.map((e) => ({ name: e.name, isDefault: e.isDefault })),
        });
        const byEnvRef = new Map<string, string>();
        for (const e of p.environments) {
          const id = r.environments[e.name.trim().slice(0, 80)];
          if (id) byEnvRef.set(e.ref, id);
        }
        tree.envByRef.set(p.ref, byEnvRef);
        tree.summary.push({ project: p.name, projectCreated: r.created, environments: Object.keys(r.environments), environmentsCreated: r.createdEnvironments });
      } catch {
        tree.warnings.push(`project "${p.name}" could not be created on the target team (needs the projects permission) — its resources go to the selected environment`);
      }
    }
    return tree;
  }

  /**
   * Mapped variant of {@link buildImportTree}: find-or-create exactly the (project, environment) groups the
   * RESOLVED mapping uses (runnable items and reconcile moves) — no empty source projects — and return the
   * environment id per itemRef. A failure THROWS (before the op row exists): the resolve already checked the
   * `projects` permission, so a silent degrade onto another environment would be a misplaced import.
   */
  private async buildMappedTree(userId: string, teamId: string, fleet: ForeignFleet, res: ResolvedMapping, projectRenames: Record<string, { name?: string }>): Promise<ImportTree> {
    const tree: ImportTree = { envByRef: new Map(), summary: [], warnings: [], envByItemRef: new Map() };
    // Source descriptions/tags are carried only for a project the tree itself placed items into (by effective name).
    const treeNames = new Set(res.effective.filter((e) => e.origin.placement === "tree" && e.project).map((e) => e.project as string));
    const meta = new Map<string, { description?: string; tags: string[] }>();
    for (const p of fleet.projects ?? []) {
      const name = projectRenames[p.ref]?.name?.normalize("NFC").trim() || p.name;
      if (treeNames.has(name)) meta.set(name, { description: p.description, tags: p.tags });
    }
    for (const g of res.projects) {
      const r = await this.projects.findOrCreateForImport(userId, teamId, {
        name: g.name,
        description: meta.get(g.name)?.description,
        tags: meta.get(g.name)?.tags,
        environments: g.environments.map((n) => ({ name: n, isDefault: n === "production" })),
      });
      for (const e of res.effective) {
        if (e.project === g.name && e.environment && r.environments[e.environment]) tree.envByItemRef!.set(e.itemRef, r.environments[e.environment]);
      }
      tree.summary.push({ project: g.name, projectCreated: r.created, environments: Object.keys(r.environments), environmentsCreated: r.createdEnvironments });
    }
    return tree;
  }

  /** Upsert each discovered GitHub App into a Tugra GitSource on `teamId`, returning providerRef → gitSourceId.
   *  Idempotent (keyed by (teamId, appId) in GitSourcesService), so a retry reuses the rows. A provider with no
   *  resolvable private key / appId, or whose upsert fails (e.g. the caller lacks `integrations` on the team),
   *  is SKIPPED with a warning — its apps fall back to the unlinked path. Warnings are FIXED strings built from
   *  the provider ref only: never an error message (a Prisma/validation error can echo the submitted data) and
   *  never a credential. */
  private async carryGitProviders(
    userId: string,
    teamId: string,
    source: ImportSource,
    providers: ForeignGitProvider[],
    /** Mapped names (providerRef → name) under an editable mapping; applied at CREATE only (upsertForImport never renames). */
    nameByRef?: ReadonlyMap<string, string>,
  ): Promise<{ gitSourceByRef: Map<string, string>; warnings: string[] }> {
    const gitSourceByRef = new Map<string, string>();
    const warnings: string[] = [];
    for (const p of providers) {
      const label = `git provider ${p.ref.slice(0, 64)}`;
      try {
        const { values } = await source.fetchSecrets(`gitProvider:${p.ref}`);
        if (!values.privateKey) {
          warnings.push(`${label}: no private key could be read from the source — its apps are left unlinked`);
          continue;
        }
        if (!p.appId) {
          warnings.push(`${label}: the GitHub App id is unknown — its apps are left unlinked`);
          continue;
        }
        const id = await this.gitSources.upsertForImport(userId, teamId, {
          name: nameByRef?.get(p.ref) ?? (p.appName || p.appSlug || `GitHub App ${p.appId}`),
          appId: p.appId,
          privateKey: values.privateKey,
          installationId: p.installationId || undefined,
          appSlug: p.appSlug || undefined,
          htmlUrl: p.htmlUrl || undefined,
          clientId: values.clientId || undefined,
          clientSecret: values.clientSecret || undefined,
          webhookSecret: values.webhookSecret || undefined,
        });
        gitSourceByRef.set(p.ref, id);
      } catch {
        warnings.push(`${label}: could not be carried into a Tugra git source — its apps are left unlinked`);
      }
    }
    return { gitSourceByRef, warnings };
  }

  /** Source refs already imported onto `serverId` by a PRIOR op whose created app/database still exists →
   *  skip on re-apply (so a retry after a partial/cancelled run never creates a duplicate app or DB). */
  private async alreadyImported(serverId: string, itemRefs: string[], excludeOpId: string): Promise<Set<string>> {
    const prior = await this.prisma.bulkTask.findMany({
      where: { itemRef: { in: itemRefs }, status: "DONE", resourceType: { in: ["application", "database"] }, serverId, opId: { not: excludeOpId } },
      select: { itemRef: true, resourceId: true, resourceType: true },
    });
    if (!prior.length) return new Set();
    const idsOf = (type: string) => prior.filter((p) => p.resourceType === type && p.resourceId).map((p) => p.resourceId as string);
    const appIds = idsOf("application");
    const dbIds = idsOf("database");
    const liveApps = new Set(appIds.length ? (await this.prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true } })).map((a) => a.id) : []);
    const liveDbs = new Set(dbIds.length ? (await this.prisma.database.findMany({ where: { id: { in: dbIds } }, select: { id: true } })).map((d) => d.id) : []);
    const out = new Set<string>();
    for (const p of prior) {
      if (!p.itemRef || !p.resourceId) continue;
      const live = p.resourceType === "database" ? liveDbs : liveApps;
      if (live.has(p.resourceId)) out.add(p.itemRef);
    }
    return out;
  }

  /** One import per target server at a time (a small check-then-create window remains; create/adopt guards back it). */
  private async assertNoInflight(serverId: string): Promise<void> {
    const inflight = await this.prisma.bulkOperation.findFirst({
      where: { kind: "import", meta: { path: ["serverId"], equals: serverId }, tasks: { some: { status: { in: ["PENDING", "RUNNING"] } } } },
      select: { id: true },
    });
    if (inflight) throw new ConflictException("an import for this server is already in progress");
  }

  private createOp(userId: string, sourceKind: string, serverId: string, planId: string, extra: Record<string, unknown> = {}) {
    return this.prisma.bulkOperation.create({
      data: { actorId: userId, command: "", kind: "import", planId, meta: { sourceKind, serverId, ...extra } },
    });
  }

  private async fanout(opId: string, taskIds: string[], run: (taskId: string) => Promise<void>): Promise<void> {
    let i = 0;
    const worker = async () => {
      while (i < taskIds.length) {
        const taskId = taskIds[i++]; // no await between read+increment → safe on the event loop
        try {
          const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { cancelRequestedAt: true } });
          if (op?.cancelRequestedAt) {
            await this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "CANCELLED", finishedAt: new Date() } });
            continue;
          }
          await run(taskId);
        } catch {
          // A DB/transport error on one task must not kill the worker or the sibling tasks. The stale-RUNNING
          // reaper in loadOwnedOp settles anything stuck, and the op can be retried.
        }
      }
    };
    const n = Math.min(CONCURRENCY, taskIds.length) || 0;
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  /** Atomically claim a task PENDING→RUNNING; 0 rows → a concurrent cancel already took it, so skip. */
  private async claim(taskId: string): Promise<boolean> {
    const claimed = await this.prisma.bulkTask.updateMany({ where: { id: taskId, status: "PENDING" }, data: { status: "RUNNING", startedAt: new Date() } });
    return claimed.count > 0;
  }

  private async runAdopt(taskId: string, serverId: string, userId: string, seed: TaskSeed): Promise<void> {
    if (!(await this.claim(taskId))) return;
    try {
      const app = await this.migrator.adopt(userId, serverId, { container: seed.adopt!.container, name: seed.name });
      await this.prisma.bulkTask.update({
        where: { id: taskId },
        data: { status: "DONE", resourceType: "application", resourceId: app.id, result: { name: app.name, appId: app.id }, finishedAt: new Date() },
      });
    } catch (e) {
      await this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "FAILED", output: msg(e), finishedAt: new Date() } });
    }
  }

  private async runCopyApp(taskId: string, source: ImportSource, app: ForeignApp, userId: string, targetServerId: string, sourceKind: RemoteSourceKind, environmentId?: string, gitSourceByRef: ReadonlyMap<string, string> = new Map(), ackedCodes: ReadonlySet<string> = new Set(), gitLinks: ReadonlyMap<string, GitLinkRow> = new Map(), eff?: EffectiveItem): Promise<void> {
    if (!(await this.claim(taskId))) return;
    try {
      const fetched = await source.fetchSecrets(app.sourceRef); // real env values (server-side only)
      const { unresolved } = fetched;
      let { values, flags } = fetched;
      // STRICT ENV (Coolify): never create an app that silently lacks variables. Keys that are not valid env names are
      // dropped here (this closes the importer's bypass of the zod env-key check), and any unresolved/invalid key that
      // the operator did not acknowledge for THIS item fails the task BEFORE apps.create: no row exists, so a retry can
      // never duplicate. Names only in the message/result; values appear nowhere.
      let unresolvedKeys: string[] = [];
      let droppedInvalid: string[] = [];
      if (STRICT_ENV_KINDS.has(sourceKind)) {
        const clean: Record<string, string> = Object.create(null);
        for (const [k, v] of Object.entries(values)) {
          if (isValidUserEnvKey(k)) clean[k] = v;
          else droppedInvalid.push(k);
        }
        droppedInvalid = [...new Set([...droppedInvalid, ...(fetched.invalidKeys ?? [])])].sort();
        if (droppedInvalid.length) {
          values = clean;
          if (flags) {
            const kept: NonNullable<typeof flags> = Object.create(null);
            for (const k of Object.keys(flags)) if (isValidUserEnvKey(k)) kept[k] = flags[k];
            flags = kept;
          }
        }
        unresolvedKeys = [...new Set(unresolved.map((u) => u.key))].sort();
        const missing = [
          ...(unresolvedKeys.length && !ackedCodes.has(ENV_RISK_UNRESOLVED) ? unresolvedKeys : []),
          ...(droppedInvalid.length && !ackedCodes.has(ENV_RISK_INVALID) ? droppedInvalid : []),
        ];
        if (missing.length) throw new Error(`env not carried: ${keyList(missing, 20)}`);
      }
      const link = gitLinks.get(app.sourceRef);
      const gitSourceId = await this.resolveGitSourceId(targetServerId, app, gitSourceByRef, link);
      // An SSH GitHub URL that a connected installation covers is created as its https twin (an App token never
      // authenticates ssh). A COPY: the shared fleet object is never mutated.
      const createApp: ForeignApp = link?.status === "linked" && link.rewriteUrl && app.git ? { ...app, git: { ...app.git, url: link.rewriteUrl } } : app;
      // Flags that could not be carried are reported by key name (never silently dropped); mapped once, used for both.
      const mappedFlags = mapSourceEnvFlags(values, flags, mapBuildPack(app).source);
      const createInput = foreignAppToCreateInput(createApp, values, { serverId: targetServerId, environmentId, sourceTag: sourceKind, gitSourceId, ...(eff ? { name: eff.name } : {}) }, flags, mappedFlags);
      const flagWarnings = mappedFlags.warnings;
      const created = await this.apps.create(userId, createInput); // re-checks apps:config on the TARGET team; deploy:false
      // Declare the app's volumes as EMPTY named mounts (their DATA is copied by a later slice). Best-effort,
      // mirroring resolveGitSourceId: a failure here must NEVER reach the outer catch, or it would leave an
      // orphan app with a FAILED task and no resourceId → a retry (alreadyImported trusts only DONE + live
      // resource) would create a DUPLICATE app. setVolumes is a whole-column replace → idempotent on retry.
      const mapped = foreignAppToVolumes(app);
      let volumes: { declared: number; skipped: number; mounts: { path: string; name: string }[]; skippedReasons: { path: string; reason: string }[]; error?: string } | undefined;
      if (mapped.volumes.length || mapped.skipped.length) {
        volumes = {
          declared: mapped.volumes.length,
          skipped: mapped.skipped.length,
          mounts: mapped.volumes.map((v) => ({ path: v.path, name: v.name })), // destination slug for the data slice; no host paths, no secrets
          skippedReasons: mapped.skipped.map((s) => ({ path: s.mountPath.slice(0, 200), reason: s.reason })),
        };
        if (mapped.volumes.length) {
          try {
            await this.apps.setVolumes(userId, created.id, mapped.volumes);
          } catch (e) {
            volumes.declared = 0;
            volumes.error = msg(e);
          }
        }
      }
      // Post-create config the create schema cannot carry (build target, watch paths, auto-deploy, limits, exec-form
      // command, replicas). Same best-effort contract as setVolumes: a setter failure NEVER reaches the outer catch.
      const extras = await this.readExtras(source, app); // never throws; secret text stays in memory, source → setter
      const postCreate = await this.applyPostCreateConfig(userId, created.id, app, targetServerId, extras);
      // Ingress beyond create's one primary domain + guessed port (extra domains, path routing, compose service
      // domains, raw published ports). Same best-effort, never-throw contract as applyPostCreateConfig.
      const ingress = await this.applyIngress(userId, created.id, app, source);
      // Mapped container alias: a stable DNS name on the Tugra network, via the existing setNetworks (which already
      // refuses swarm/compose/raw --network/reserved/taken). Same never-throw contract as the setters above — a
      // throw after the app row exists would orphan it and a retry would duplicate it.
      const alias = eff?.containerAlias ? await this.applyAlias(userId, created.id, eff.containerAlias) : undefined;
      // Surface a declare FAILURE or skipped mounts on the task itself (the view renders `output` as the task
      // message) — otherwise a silently-empty app contradicts the plan's "a volume is declared" promise. A clean
      // declare (or a no-volume app) leaves `output` unset, so those rows stay byte-identical to before.
      const volNote =
        volumes && (volumes.error || volumes.skipped > 0)
          ? `volumes: ${volumes.declared} declared${volumes.skipped ? `, ${volumes.skipped} skipped (${[...new Set(mapped.skipped.map((s) => s.reason))].sort().join(", ")})` : ""}${volumes.error ? `; declare FAILED: ${volumes.error}` : ""}`
          : undefined;
      const cfgNote = postCreate.unmapped.length
        ? `config not carried: ${postCreate.unmapped.map((u) => u.field).join(", ")}`
        : undefined;
      const ingressNote = ingress.unmapped.length
        ? `ingress not carried: ${ingress.unmapped.map((u) => u.field).join(", ")}`
        : undefined;
      const flagNote = flagWarnings.length ? `env flags not carried: ${flagWarnings.join("; ")}` : undefined;
      const notCarriedKeys = [...unresolvedKeys, ...droppedInvalid.filter((k) => !unresolvedKeys.includes(k))];
      const envNote = notCarriedKeys.length ? `env not carried (acknowledged): ${keyList(notCarriedKeys, 20)}` : undefined;
      const git = link ? await this.gitOutcome(created.id, link) : undefined;
      const aliasNote = alias && !alias.applied ? `container alias not applied: ${alias.reason}` : undefined;
      const note = [volNote, cfgNote, ingressNote, flagNote, envNote, aliasNote, git?.note].filter(Boolean).join("; ") || undefined;
      await this.prisma.bulkTask.update({
        where: { id: taskId },
        data: {
          status: "DONE",
          resourceType: "application",
          resourceId: created.id,
          // count only — never the values; `volumes` omitted entirely for an app with no mounts (byte-identical to before)
          result: { name: created.name, ...(eff ? { sourceName: app.name, mapped: true } : {}), appId: created.id, unresolvedEnv: unresolved.length, ...(alias ? { aliasApplied: alias.applied } : {}), ...(unresolvedKeys.length ? { unresolvedKeys: unresolvedKeys.slice(0, 50) } : {}), ...(droppedInvalid.length ? { droppedInvalidKeys: droppedInvalid.slice(0, 50) } : {}), ...(git ? { git: git.result } : {}), ...(volumes ? { volumes } : {}), ...(postCreate.applied.length || postCreate.unmapped.length ? { postCreate } : {}), ...(ingress.applied.length || ingress.unmapped.length ? { ingress } : {}) },
          ...(note ? { output: note } : {}),
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "FAILED", output: msg(e), finishedAt: new Date() } });
    }
  }

  /** Set a mapped container alias through the existing setNetworks. NEVER throws; a failure is a fixed reason. */
  private async applyAlias(userId: string, appId: string, alias: string): Promise<{ applied: boolean; reason?: "reserved" | "taken" | "unsupported" | "other" }> {
    try {
      await this.apps.setNetworks(userId, appId, { containerAlias: alias });
      return { applied: true };
    } catch (e) {
      return { applied: false, reason: aliasFailureReason(e) };
    }
  }

  /**
   * Reconcile ONE already-imported item with its mapped name / environment / alias through the existing in-place
   * methods (each re-checks authz). Behind the explicit `reconcile` flag only. Each step is individually
   * try/catch and NEVER throws; failures become fixed notes. The task ends SKIPPED (never DONE) with the
   * resource ids for display, so rollback (acts on DONE application tasks) and the idempotency scan (DONE only)
   * stay blind to it: an earlier op's resource can never be removed through a reconcile.
   */
  private async runReconcile(taskId: string, userId: string, eff: EffectiveItem, envId: string | undefined): Promise<void> {
    if (!(await this.claim(taskId))) return;
    const id = eff.existing?.resourceId;
    const isDb = eff.existing?.resourceType === "database";
    const done: string[] = [];
    const notes: string[] = [];
    const step = async (field: "name" | "environment" | "containerAlias", fn: () => Promise<unknown>) => {
      try {
        await fn();
        done.push(field);
      } catch {
        notes.push(`${field} not reconciled`);
      }
    };
    try {
      if (id) {
        const drift = new Set(eff.drift ?? []);
        if (drift.has("name")) await step("name", () => (isDb ? this.dbs.rename(userId, id, eff.name) : this.apps.rename(userId, id, eff.name)));
        if (drift.has("environment")) {
          if (envId) await step("environment", () => (isDb ? this.dbs.setEnvironment(userId, id, envId) : this.apps.setEnvironment(userId, id, envId)));
          else notes.push("environment not reconciled");
        }
        if (drift.has("containerAlias") && !isDb) await step("containerAlias", () => this.apps.setNetworks(userId, id, { containerAlias: eff.containerAlias ?? null }));
      }
      const output = `already imported onto this server in a previous run; reconciled: ${done.join(", ") || "nothing"}${notes.length ? `; ${notes.join("; ")}` : ""}`;
      await this.prisma.bulkTask.update({
        where: { id: taskId },
        data: {
          status: "SKIPPED",
          ...(eff.existing ? { resourceType: eff.existing.resourceType, resourceId: eff.existing.resourceId } : {}),
          output,
          result: { name: eff.name, sourceName: eff.sourceName, mapped: true, reconciled: done },
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "FAILED", output: msg(e), finishedAt: new Date() } });
    }
  }

  /** The Tugra GitSource an imported app is created linked to. Two disjoint paths:
   *  - an app that cloned through a SPECIFIC source GitHub App (`gitProviderRef`, Dokploy): link only to that exact
   *    carried source (re-verified on the TARGET team + installed). Absent/un-installed => UNLINKED, never a guess;
   *  - everything else: the repo-visibility resolution (`link.status === "linked"`), which only proves a source that
   *    can actually see the repo. The old "exactly one installed source" heuristic is gone (D7).
   *  Best-effort: never throws (a lookup failure just means no auto-link). */
  private async resolveGitSourceId(targetServerId: string, app: ForeignApp, gitSourceByRef: ReadonlyMap<string, string> = new Map(), link?: GitLinkRow): Promise<string | undefined> {
    if (!app.gitProviderRef) return link?.status === "linked" ? link.sourceId : undefined;
    if (app.git?.provider !== "github") return undefined;
    try {
      const server = await this.prisma.server.findUnique({ where: { id: targetServerId }, select: { teamId: true } });
      if (!server) return undefined;
      // This app cloned through a SPECIFIC GitHub App at the source. Link only to that exact carried source
      // (re-verified on the target team + installed). If it is absent or un-installed, stay UNLINKED.
      const carried = gitSourceByRef.get(app.gitProviderRef);
      if (!carried) return undefined;
      const row = await this.prisma.gitSource.findFirst({ where: { id: carried, teamId: server.teamId, installationId: { not: null } }, select: { id: true } });
      return row ? row.id : undefined;
    } catch {
      return undefined;
    }
  }

  /** The per-task git outcome (status + source NAME + the app's PUBLIC deploy key) and its note. Never a credential.
   *  Best-effort: a failed deploy-key read degrades the note, it never throws (the app row already exists). */
  private async gitOutcome(appId: string, link: GitLinkRow): Promise<{ result: { status: GitLinkRow["status"]; sourceName?: string; rewritten?: boolean; deployKeyPublic?: string }; note: string }> {
    const result: { status: GitLinkRow["status"]; sourceName?: string; rewritten?: boolean; deployKeyPublic?: string } = { status: link.status };
    if (link.sourceName) result.sourceName = link.sourceName;
    if (link.rewriteUrl) result.rewritten = true;
    if (link.status === "linked") return { result, note: `git: linked to "${link.sourceName ?? "source"}"${link.rewriteUrl ? " (ssh URL converted to https)" : ""}` };
    if (link.status === "public_ok") return { result, note: "git: public repository, cloned without a connected source" };
    if (link.status === "ssh_deploy_key") {
      let pub: string | undefined;
      try {
        const row = await this.prisma.application.findUnique({ where: { id: appId }, select: { gitSshPublicKey: true } });
        pub = row?.gitSshPublicKey ?? undefined; // PUBLIC key only; the private key never leaves the encrypted column
      } catch {
        pub = undefined;
      }
      if (pub) result.deployKeyPublic = pub;
      return { result, note: pub ? `git: SSH deploy key generated - add this PUBLIC key to the repo: ${pub}` : "git: SSH deploy key generated - copy its public key from the app's Git settings and add it to the repo" };
    }
    return { result, note: `git: NOT LINKED (${link.status}) - a private repo will fail its first clone; connect a GitHub source then use Re-check` };
  }

  /** Re-read the app's container labels / inline Dockerfile text from the source (secret-capable, in memory only).
   *  Returns `undefined` (old path, byte-identical output) unless the source offers `fetchAppExtras`, the app carries
   *  the discover-time marker, and it is not a compose app. NEVER throws: a failed read must not reach runCopyApp's
   *  outer catch (an orphan app + FAILED task would make a retry create a duplicate, see the setters' comment), so it
   *  becomes a FIXED unmapped note — never the error text (it can carry a URL). */
  private async readExtras(source: ImportSource, app: ForeignApp): Promise<SourceAppExtras | undefined> {
    if (!source.fetchAppExtras || !app.sourceExtras || mapBuildPack(app).source === "COMPOSE") return undefined;
    try {
      return await source.fetchAppExtras(app.sourceRef);
    } catch {
      return { unmapped: [{ field: "sourceExtras", ...why("extras_read_failed") }] };
    }
  }

  /** Apply {@link foreignAppToPostCreateConfig} through the ApplicationsService setters. Best-effort and idempotent
   *  (every setter is a whole-value replace): each failure is recorded and NEVER thrown. The returned summary is
   *  field NAMES + fixed reasons only — never values (an exec-form command can embed credentials). */
  private async applyPostCreateConfig(
    userId: string,
    appId: string,
    app: ForeignApp,
    targetServerId: string,
    extras?: SourceAppExtras,
  ): Promise<{ applied: string[]; unmapped: Unmapped[] }> {
    const applied: string[] = [];
    const cfg = foreignAppToPostCreateConfig(app, extras);
    const unmapped = [...cfg.unmapped];
    const run = async (field: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        applied.push(field);
      } catch {
        unmapped.push({ field, ...why("setting_rejected") });
      }
    };
    if (cfg.build) {
      await run("build", () => this.apps.setBuild(userId, appId, cfg.build!));
      if (cfg.build.inlineDockerfile) {
        // setBuild is one call: it either carried the text or was rejected (`build` is then in `unmapped`, and the
        // inline text is named separately so the failure says which field was lost).
        if (applied.includes("build")) applied.push("inlineDockerfile");
        else unmapped.push({ field: "inlineDockerfile", ...why("inline_dockerfile_rejected") });
      }
    }
    if (cfg.customLabels) await run("customLabels", () => this.apps.setCustomLabels(userId, appId, cfg.customLabels!));
    if (cfg.watchPaths) await run("watchPaths", () => this.apps.setWatchPaths(userId, appId, cfg.watchPaths!));
    if (cfg.autoDeploy !== undefined) await run("autoDeploy", () => this.apps.setAutoDeploy(userId, appId, cfg.autoDeploy!));
    if (cfg.limits) await run("limits", () => this.apps.setLimits(userId, appId, cfg.limits!));
    if (cfg.containerCommand) await run("containerCommand", () => this.apps.setContainerCommand(userId, appId, cfg.containerCommand!));
    if (cfg.replicas !== undefined) {
      // Replicas map to setClusterConfig, which CONVERTS the app into a swarm service (re-homes its domain, pins
      // a stateful app to the cluster manager instead of the chosen target server, and needs apps:deploy + a
      // registry) — far too surprising to apply silently during an import. Carry it as unmapped; the planner
      // surfaces replicas as an explicit choice (next slice).
      unmapped.push({ field: "replicas", ...why("replicas") });
    }
    return { applied, unmapped };
  }

  /** Apply {@link foreignAppToIngressPlan} through the ApplicationsService setters, in order: extra domains →
   *  path options → corrected container port → raw published ports → compose service domains. Best-effort like
   *  {@link applyPostCreateConfig}: a setter failure is recorded as `unmapped` and NEVER thrown (a throw would
   *  orphan the created app and a retry would duplicate it). The two replace-set host lists fall back to
   *  one-by-one on a batch rejection, so a single clashing hostname costs only itself. Summary = field names,
   *  hostnames and port numbers + fixed reasons — never an env/credential value. */
  private async applyIngress(
    userId: string,
    appId: string,
    app: ForeignApp,
    source: ImportSource,
  ): Promise<{ applied: string[]; unmapped: Unmapped[] }> {
    const applied: string[] = [];
    let plan: ReturnType<typeof foreignAppToIngressPlan>;
    try {
      plan = foreignAppToIngressPlan(app);
    } catch {
      return { applied, unmapped: [{ field: "ingress", ...why("ingress_uninterpretable") }] };
    }
    const unmapped = [...plan.unmapped];
    const rejected = why("setting_rejected");
    const run = async (field: string, fn: () => Promise<unknown>, reason: Reasoned = rejected) => {
      try {
        await fn();
        applied.push(field);
      } catch {
        // FIXED reason only — never the error text (it could echo a credential).
        unmapped.push({ field, ...reason });
      }
    };
    /** Replace-set list: try it whole; if rejected, rebuild it item by item (each call replaces the whole set,
     *  so the growing prefix is valid) and report only the items Tugra refuses. */
    const runList = async <T>(field: string, items: T[], label: (t: T) => string, set: (items: T[]) => Promise<unknown>) => {
      if (!items.length) return;
      try {
        await set(items);
        applied.push(field);
        return;
      } catch {
        /* fall through to per-item */
      }
      const kept: T[] = [];
      for (const it of items) {
        try {
          await set([...kept, it]);
          kept.push(it);
        } catch {
          unmapped.push({ field: `${field}:${label(it)}`, ...rejected });
        }
      }
      if (kept.length) applied.push(field);
    };
    await runList("extraDomains", plan.extraDomains, (h) => h, (hosts) => this.apps.setExtraDomains(userId, appId, hosts));
    if (plan.domainOptions) await run("domainOptions", () => this.apps.setDomainOptions(userId, appId, plan.domainOptions!));
    if (plan.containerPort !== undefined) await run("containerPort", () => this.apps.setContainerPort(userId, appId, plan.containerPort!));
    await runList("extraPorts", plan.extraPorts, (p) => `${p.hostPort}/${p.protocol}`, (ports) => this.apps.setExtraPorts(userId, appId, ports));
    await runList("serviceDomains", plan.serviceDomains, (r) => r.hostname, (rows) => this.apps.setServiceDomains(userId, appId, rows));
    if (plan.redirects?.length) await run("redirects", () => this.apps.setRedirects(userId, appId, plan.redirects!));
    // Basic-auth: the fleet carries usernames only; the passwords are fetched server-side here, bcrypt-hashed by
    // setBasicAuth, and never persisted/returned in plaintext. Any failure (no creds / read error) is an unmapped
    // 'basicAuth' with a FIXED reason — a password-gated app must be re-protected before cutover.
    if (app.basicAuth?.users?.length) {
      let dropped = 0;
      await run(
        "basicAuth",
        async () => {
          const creds = await source.fetchBasicAuthCredentials?.(app.sourceRef);
          if (!creds || !creds.length) throw new Error("no basic-auth credentials");
          // Only credentials Tugra can faithfully store (an htpasswd-unsafe username would corrupt the whole
          // auth line); keep each valid one so the app stays gated, and report the rest.
          const seenUsers = new Set<string>();
          const usable = creds.filter((c) => {
            const ok = !seenUsers.has(c.user) && SetBasicAuthSchema.safeParse({ users: [c] }).success;
            if (ok) seenUsers.add(c.user);
            return ok;
          });
          dropped = creds.length - usable.length;
          if (!usable.length) throw new Error("no storable basic-auth credentials");
          // Enforce the controller's per-app cap (SetBasicAuthSchema caps users at 20); setBasicAuth does not revalidate.
          const capped = usable.slice(0, 20);
          dropped += usable.length - capped.length;
          await this.apps.setBasicAuth(userId, appId, capped);
        },
        why("basic_auth_not_carried"),
      );
      if (dropped > 0) unmapped.push({ field: "basicAuth users", ...why("basic_auth_users_dropped") });
    }
    return { applied, unmapped };
  }

  /** Provision an empty Tugra database for a discovered source DB (deploy:false — the record is created,
   *  the container + DATA come later). Records the sourceRef→destResourceId mapping so the migrator can
   *  restore into it. When the source can supply the DB's REAL credentials (source.fetchDbCredentials) they are
   *  carried — together with the VERBATIM image and the published host port — through
   *  DatabasesService.createForImport, so a migrated app reconnects with the SAME password. The credentials flow
   *  source → memory → DatabasesService (encrypted at rest) only: the task result/output carries flags and fixed
   *  strings, never a value. Without credentials it falls back to a freshly minted password + a warning. */
  private async runCreateDb(taskId: string, source: ImportSource, db: ForeignDb, userId: string, targetServerId: string, environmentId?: string, eff?: EffectiveItem): Promise<void> {
    if (!(await this.claim(taskId))) return;
    try {
      const engine = db.engine as CreateDatabaseInput["engine"]; // PROVISIONABLE_ENGINES-gated before enqueue
      // A source WITHOUT the method (?. → undefined) degrades to fresh credentials. But a source that HAS it and
      // THROWS (a transient / permission read error) must FAIL the task, never silently mint a fresh password the
      // retry would keep as DONE. Re-throw a FIXED message: the raw client error could echo the response body
      // (which carries the password), so it must not reach the FAILED task output.
      let carried: FetchedDbCredentials | undefined;
      try {
        carried = (await source.fetchDbCredentials?.(db.sourceRef)) ?? undefined;
      } catch {
        throw new Error("could not read the source database credentials — retry the import");
      }
      const notes: string[] = [];
      let created: DatabaseView;
      let flags: { credentialsCarried: boolean; imageCarried?: boolean; hostPortCarried?: boolean };
      if (carried?.password) {
        // The host port is carried only when valid and not already published by another Tugra database on the
        // target server (a clash would keep the container from starting) — otherwise dropped with a note.
        let hostPort: number | undefined;
        if (db.externalPort !== undefined) {
          if (Number.isInteger(db.externalPort) && db.externalPort >= 1 && db.externalPort <= 65535) {
            const taken = await this.prisma.database.findFirst({ where: { serverId: targetServerId, hostPort: db.externalPort }, select: { id: true } });
            if (taken) notes.push(`host port ${db.externalPort} is already used by another database on this server — not published; set one in Tugra`);
            else hostPort = db.externalPort;
          } else {
            notes.push("the source host port is invalid — not published");
          }
        }
        created = await this.dbs.createForImport(userId, {
          name: eff?.name ?? db.name,
          serverId: targetServerId,
          engine,
          version: db.version,
          image: db.image, // verbatim; createForImport validates it as a shell-safe OCI ref and gates it behind apps:config
          username: carried.user || db.credentials?.username || "tugra",
          password: carried.password,
          database: carried.database || db.credentials?.database || safeDbIdent(db.name),
          hostPort,
          environmentId,
        });
        flags = { credentialsCarried: true, imageCarried: !!db.image, hostPortCarried: hostPort !== undefined };
        if (carried.rootPassword && carried.rootPassword !== carried.password && (engine === "MYSQL" || engine === "MARIADB")) {
          notes.push("the source has a separate root password — Tugra uses one password for the user and root, so root logins need the user password");
        }
      } else {
        const input: CreateDatabaseInput = { name: eff?.name ?? db.name, serverId: targetServerId, engine, version: db.version, environmentId };
        // Under a mapping the internal identifier is PINNED to what the un-renamed import would have produced
        // (slug of the SOURCE name) or the mapped override — a display rename never changes it.
        created = eff
          ? await this.dbs.createPinned(userId, input, { database: eff.dbIdentifier ?? dbSlug(db.name).slice(0, 63) })
          : await this.dbs.create(userId, input); // re-checks `databases` on the TARGET team; no deploy
        flags = { credentialsCarried: false };
        notes.push("DB credentials not carried — fresh password minted; rewire the app DB_PASSWORD");
      }
      // Carry the DB's hard CPU/memory limits. Best-effort, like the app post-create setters: the DB row already
      // exists with its resourceId, so a setLimits failure must NOT fail the task (a retry would skip the DB).
      if (db.limits && (db.limits.memoryMb !== undefined || db.limits.cpus !== undefined)) {
        try {
          await this.dbs.setLimits(userId, created.id, { memoryMb: db.limits.memoryMb ?? null, cpus: db.limits.cpus ?? null });
        } catch {
          notes.push("the CPU/memory limit was not applied — set it on the Tugra database");
        }
      }
      await this.prisma.bulkTask.update({
        where: { id: taskId },
        data: {
          status: "DONE",
          resourceType: "database",
          resourceId: created.id,
          result: { name: created.name, ...(eff ? { sourceName: db.name, mapped: true } : {}), databaseId: created.id, ...flags }, // flags only — never a credential value
          ...(notes.length ? { output: notes.join("; ") } : {}),
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "FAILED", output: msg(e), finishedAt: new Date() } });
    }
  }

  /** Poll an operation's progress. Scoped to its creator. Returns a redacted view (no compensation blobs). */
  async status(userId: string, opId: string) {
    const op = await this.loadOwnedOp(userId, opId);
    return toStatusView(op);
  }

  /** Request cancellation: flip the cooperative flag and mark any not-yet-started tasks CANCELLED. */
  async cancel(userId: string, opId: string) {
    const op = await this.loadOwnedOp(userId, opId);
    if (!op.cancelRequestedAt) {
      await this.prisma.bulkOperation.update({ where: { id: opId }, data: { cancelRequestedAt: new Date() } });
    }
    await this.prisma.bulkTask.updateMany({
      where: { opId, status: "PENDING" },
      data: { status: "CANCELLED", finishedAt: new Date() },
    });
    await this.audit.log({ actor: userId, action: "import.cancel", target: opId });
    // A cancelled import is abandoned → kill any live migration token so a copied command stops working.
    await this.migrationTokens.revoke(opId, userId).catch((e) => this.logger.warn(`migration-token revoke failed for ${opId}: ${msg(e)}`));
    await cleanupOpStaging(opId).catch(() => undefined); // reclaim any staged migration artifacts
    return this.status(userId, opId);
  }

  /**
   * Undo an operation's completed work: local-docker un-adopts (rename the container back + drop the record);
   * coolify copy-mode removes each created app. Never while the fan-out is still running, and never an app the
   * user has (re)deployed since import — that is no longer in its as-imported state, so we leave it.
   */
  async rollback(userId: string, opId: string, opts: RollbackOptions = {}) {
    const op = await this.loadOwnedOp(userId, opId);
    const taskName = (t: { result: unknown }): string | undefined => (typeof t.result === "object" && t.result ? (t.result as { name?: string }).name : undefined);
    // A data-bearing resource is removed ONLY when the operator asked for data removal AND typed its exact name.
    const dataAllowed = (t: { result: unknown }): boolean => {
      const name = taskName(t);
      return opts.includeData === true && !!name && (opts.dataConfirmNames ?? []).includes(name);
    };
    if (deriveOpStatus(op.tasks.map((t) => t.status as TaskStatus)) === "RUNNING") {
      throw new ConflictException("the import is still running — cancel it and wait for it to stop before rolling back");
    }
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { sourceKind?: string; serverId?: string }) : {};
    const serverId = meta.serverId;
    const sourceKind = meta.sourceKind;
    if (!serverId) throw new ConflictException("operation has no target server to roll back");
    // Primary authz gate (destructive): the per-app unadopt/remove re-checks too (defence in depth).
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");

    // Mark the op rolled-back BEFORE teardown so minting/validation is blocked for the whole window (a
    // best-effort revoke alone is not enough — this persistent marker is what assertCanMigrate + the token
    // guard's validate() honour, so even a missed revoke cannot resurrect a usable token).
    await this.prisma.bulkOperation.update({ where: { id: opId }, data: { meta: { ...meta, rolledBackAt: new Date().toISOString() } } });
    await this.migrationTokens.revoke(opId, userId).catch((e) => this.logger.warn(`migration-token revoke failed for ${opId}: ${msg(e)}`));

    // Apps whose volume DATA this migration touched (P3) must NOT be torn down: apps.remove runs
    // `docker volume rm`, which would silently destroy the migrated data. The data task stamps the owning
    // app's provisioning itemRef in result.appItemRef AT CLAIM TIME, so a DONE, FAILED, or stale-reaped data
    // task all carry it — a FAILED resync can leave the earlier good data intact (the import script stages to
    // a temp file BEFORE the wipe), and a mid-extract failure can leave partial data. Either way, never
    // auto-remove: collect every data task's appItemRef regardless of status, then skip those apps.
    const restoredDataApps = new Set<string>();
    const restoredDataDbs = new Set<string>();
    const dataTasks = op.tasks.filter((t) => t.kind === "data");
    // Streamed (v2) copies: a transfer that is APPLYING or DONE has written the destination volume, so its app/database is
    // protected exactly like a v1 restore; a COPYING/COPIED/FAILED one only holds staged parts on the target, which are
    // cleaned up instead of blocking the rollback.
    const vxData = dataTasks.filter((t) => typeof t.result === "object" && t.result && (t.result as { vx?: boolean }).vx === true);
    const transfers = vxData.length ? await this.prisma.migrationVolumeTransfer.findMany({ where: { opId } }) : [];
    const transferOf = new Map(transfers.map((t) => [`data:${t.itemRef}`, t]));
    for (const dt of dataTasks) {
      const res = typeof dt.result === "object" && dt.result ? (dt.result as { appItemRef?: string; databaseItemRef?: string; vx?: boolean }) : {};
      if (res.vx === true) {
        const tr = dt.itemRef ? transferOf.get(dt.itemRef) : undefined;
        if (tr && (tr.state === "APPLYING" || tr.state === "DONE")) {
          if (res.appItemRef) restoredDataApps.add(res.appItemRef);
          if (res.databaseItemRef) restoredDataDbs.add(res.databaseItemRef);
        } else if (tr) {
          await this.vxApply?.cleanupTarget(tr.id, tr.targetServerId).catch(() => false);
          await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: tr.id, state: { in: ["PENDING", "COPYING", "COPIED", "FAILED"] } }, data: { state: "ABORTED", runId: null, error: "the import was rolled back" } });
        }
        continue;
      }
      if (res.appItemRef) restoredDataApps.add(res.appItemRef);
    }

    const done = op.tasks.filter((t) => t.status === "DONE" && t.resourceType === "application" && t.resourceId);
    for (const t of done) {
      const appId = t.resourceId!;
      const app = await this.prisma.application.findUnique({ where: { id: appId }, select: { id: true } });
      if (!app) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { status: "ROLLED_BACK", output: "app already removed", finishedAt: new Date() } });
        continue;
      }
      if (t.itemRef && restoredDataApps.has(t.itemRef) && !dataAllowed(t)) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: "rollback skipped: app volume data was restored by this migration — remove it manually if intended" } });
        continue;
      }
      const runPrefix = opts.runOwnedDeployments ? `migrun:${opts.runOwnedDeployments.runId}:` : null;
      const foreignDeployments = await this.prisma.deployment.count({
        where: runPrefix ? { appId, OR: [{ idempotencyKey: null }, { NOT: { idempotencyKey: { startsWith: runPrefix } } }] } : { appId },
      });
      if (foreignDeployments > 0) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: "rollback skipped: app has been (re)deployed since import — remove it manually if intended" } });
        continue;
      }
      try {
        if (COPY_MODE_KINDS.has(sourceKind ?? "")) {
          await this.apps.remove(userId, appId); // a copy-mode import creates a fresh Tugra app → full teardown
        } else {
          const originalName = typeof t.compensation === "object" && t.compensation ? (t.compensation as { originalName?: string }).originalName : undefined;
          if (!originalName) {
            await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: "rollback skipped: original container name not recorded" } });
            continue;
          }
          await this.migrator.unadopt(userId, serverId, appId, originalName);
        }
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { status: "ROLLED_BACK", finishedAt: new Date() } });
      } catch (e) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: `rollback failed: ${msg(e)}` } });
      }
    }
    // Databases provisioned by this import (coolify copy-mode) are freshly created empty records → tear
    // them down too, so a rollback leaves nothing behind. (local-docker never creates database tasks.)
    const doneDbs = op.tasks.filter((t) => t.status === "DONE" && t.resourceType === "database" && t.resourceId);
    for (const t of doneDbs) {
      const dbId = t.resourceId!;
      const existing = await this.prisma.database.findUnique({ where: { id: dbId }, select: { id: true, status: true } });
      if (!existing) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { status: "ROLLED_BACK", output: "database already removed", finishedAt: new Date() } });
        continue;
      }
      if (t.itemRef && restoredDataDbs.has(t.itemRef) && !dataAllowed(t)) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: "rollback skipped: database data was copied by this migration — remove it manually if intended" } });
        continue;
      }
      // NEVER destroy a DB that has left its as-provisioned EMPTY state: dbs.remove does `docker rm -f`
      // + `docker volume rm`, so once the DB has been started (status != NEW) or had data restored/backed
      // up into it (the whole point — the migrator restores INTO it), teardown would be irreversible data
      // loss. Mirror the app guard: skip and leave it for explicit manual removal (keep status DONE).
      const used =
        existing.status !== "NEW" ||
        (await this.prisma.restore.count({ where: { databaseId: dbId } })) > 0 ||
        (await this.prisma.backup.count({ where: { databaseId: dbId } })) > 0;
      if (used && !dataAllowed(t)) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: "rollback skipped: database has been provisioned/restored since import — remove it manually if intended" } });
        continue;
      }
      try {
        await this.dbs.remove(userId, dbId);
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { status: "ROLLED_BACK", finishedAt: new Date() } });
      } catch (e) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: `rollback failed: ${msg(e)}` } });
      }
    }
    await this.audit.log({ actor: userId, action: "import.rollback", target: opId, meta: { serverId, count: done.length + doneDbs.length } });
    await cleanupOpStaging(opId).catch(() => undefined); // the imported resources are gone → drop any staged artifacts
    return this.status(userId, opId);
  }

  /**
   * Mint a one-time migration token for this op so the untrusted SOURCE host can stream its volume/DB data
   * to the hub. Refuses (409) if a token is already live — use {@link reissueMigrationToken} to rotate — so
   * an accidental double-click never invalidates a command the host may already hold. The returned command
   * is shown ONCE: the token is hashed at rest and unrecoverable afterwards.
   */
  async mintMigrationToken(userId: string, opId: string, base: string, opts: { certs?: boolean } = {}) {
    const op = await this.loadOwnedOp(userId, opId);
    await this.assertCanMigrate(userId, op);
    assertSafeBase(base); // fail fast on an unsafe hub URL BEFORE a token is minted (none left behind on 400)
    await this.captureHubBase(opId, op.meta, base); // trusted capture (actor's request) for the agent download later
    const { token, expiresAt } = await this.migrationTokens.issue(opId);
    await this.auditTokenOrElseRevoke(userId, opId, "import.migration_token.mint", expiresAt);
    return { opId, token, expiresAt, command: buildMigrationCommand(token, base, opts), ...(vxEnabled() ? { commands: buildMigrationCommands(token, base) } : {}) };
  }

  /** Rotate the migration token: revoke the old and mint a new one atomically (works with or without a prior token). */
  async reissueMigrationToken(userId: string, opId: string, base: string, opts: { certs?: boolean } = {}) {
    const op = await this.loadOwnedOp(userId, opId);
    await this.assertCanMigrate(userId, op);
    assertSafeBase(base);
    await this.captureHubBase(opId, op.meta, base);
    const { token, expiresAt } = await this.migrationTokens.reissue(opId);
    await this.auditTokenOrElseRevoke(userId, opId, "import.migration_token.reissue", expiresAt);
    return { opId, token, expiresAt, command: buildMigrationCommand(token, base, opts), ...(vxEnabled() ? { commands: buildMigrationCommands(token, base) } : {}) };
  }

  /** Persist the hub origin the AUTHENTICATED actor reached us on, so the (untrusted) ingest path can later
   *  hand the agent a download URL on a trusted host instead of trusting the ingest request's Host header. */
  private async captureHubBase(opId: string, meta: unknown, base: string): Promise<void> {
    const m = typeof meta === "object" && meta ? (meta as Record<string, unknown>) : {};
    await this.prisma.bulkOperation.update({ where: { id: opId }, data: { meta: { ...m, hubBase: base } } });
  }

  /** The hash is committed before this runs, so if the audit write fails we must not leave an orphan live
   *  credential the caller never received — best-effort revoke it and surface the error so a retry works. */
  private async auditTokenOrElseRevoke(userId: string, opId: string, action: string, expiresAt: Date): Promise<void> {
    try {
      await this.audit.log({ actor: userId, action, target: opId, meta: { expiresAt } });
    } catch (e) {
      await this.migrationTokens.revoke(opId, userId).catch(() => undefined);
      throw e;
    }
  }

  /** Read-only migration state + a command TEMPLATE. Never returns the live token (hashed at rest): the UI
   *  captures the real command from the mint/reissue response once, then shows active/expiresAt + Reissue. */
  async migrateCommand(userId: string, opId: string, base: string, opts: { certs?: boolean } = {}) {
    const op = await this.loadOwnedOp(userId, opId);
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { rolledBackAt?: string }) : {};
    const expiresAt = op.migrationTokenExpiresAt;
    const active = !!op.migrationTokenHash && !!expiresAt && expiresAt.getTime() > Date.now() && !op.cancelRequestedAt && !meta.rolledBackAt;
    return { opId, active, expiresAt: active ? expiresAt : null, commandTemplate: buildMigrationCommandTemplate(base, opts), ...(vxEnabled() ? { commandsTemplate: buildMigrationCommandsTemplate(base) } : {}) };
  }

  /**
   * READ-ONLY env-remap preview (S4d-2). For a settled Coolify copy-mode import, propose how each migrated
   * app's env should be rewritten so it points at its new Tugra database instead of the old Coolify host.
   * It writes NOTHING: it decrypts each app's env + each DB's connection facts server-side, runs the pure
   * {@link remapEnv} engine, and returns a SECRET-MASKED diff + a planHash the apply (a later slice) will
   * confirm against. The per-DB mode reflects REALITY: if the Tugra DB's current credentials already match
   * the ones the app's own URL carries (a createForImport provision), only the host is swapped (preserve);
   * otherwise the whole connection is rewritten to the fresh Tugra credentials (rotate) and a split
   * credential var it cannot confirm is reported for manual review — never a half-rewrite.
   */
  async remapEnvPlan(userId: string, opId: string) {
    const { pub } = await this.computeRemapPlan(userId, opId);
    return pub;
  }

  /**
   * The shared remap computation behind BOTH the preview and the apply. It returns the exact secret-free
   * public plan (incl. the planHash) the preview surfaces AND an internal `writes` list carrying the RAW new
   * values — which is NEVER returned to a client. Computing both from one pass guarantees the diff the
   * operator confirmed and the bytes the apply writes can never diverge, and that the planHash the apply
   * re-derives is identical to the one the preview showed.
   */
  private async computeRemapPlan(userId: string, opId: string) {
    const op = await this.loadOwnedOp(userId, opId, { reapData: false }); // never kill an in-flight restore
    await this.assertCanMigrate(userId, op); // coolify copy-mode, settled, creator still holds apps:config
    const meta = op.meta as { serverId: string; sourceKind?: string; services?: Array<{ itemRef: string; name: string; oldHost: string }> };
    const hostShape = remapHostShapeFor(meta.sourceKind);
    const sourceServices = meta.sourceKind === "coolify" && Array.isArray(meta.services) ? meta.services.filter((sv) => sv && typeof sv.oldHost === "string" && typeof sv.itemRef === "string") : undefined;
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(userId, server.teamId, "databases"); // reading DB credentials

    const skipped: Array<{ itemRef: string; kind: "database" | "application"; reason: string }> = [];
    const skippedDbHosts = new Set<string>(); // old hosts whose DB we could NOT load — surfaced per app, not silently clean

    // DONE app destinations → their decrypted env (writer-gated). Fetched first so a DB's mode can be
    // decided from the app URLs that reference it.
    const appEnvs: Array<{ itemRef: string; appId: string; name: string; env: Record<string, string> }> = [];
    for (const t of op.tasks) {
      if (t.status !== "DONE" || t.resourceType !== "application" || !t.resourceId || !t.itemRef) continue;
      let env: Record<string, string>;
      try {
        env = await this.apps.getEnv(userId, t.resourceId);
      } catch {
        skipped.push({ itemRef: t.itemRef, kind: "application", reason: "not-accessible" });
        continue;
      }
      const r = typeof t.result === "object" && t.result ? (t.result as { name?: string }) : {};
      appEnvs.push({ itemRef: t.itemRef, appId: t.resourceId, name: r.name ?? t.itemRef, env });
    }

    // DONE database destinations → their Tugra connection facts (writer view decrypts the creds). A DB we
    // cannot load (deleted / no creds visible) is SKIPPED but recorded, never aborts the whole preview.
    const dbInfos: Array<{ itemRef: string; oldHost: string; dv: DatabaseView }> = [];
    for (const t of op.tasks) {
      if (t.status !== "DONE" || t.resourceType !== "database" || !t.resourceId || !t.itemRef) continue;
      const oldHost = sourceRefOf(t.itemRef);
      if (!oldHost) {
        skipped.push({ itemRef: t.itemRef, kind: "database", reason: "bad-itemref" });
        continue;
      }
      let dv: DatabaseView;
      try {
        dv = await this.dbs.get(userId, t.resourceId);
      } catch {
        skipped.push({ itemRef: t.itemRef, kind: "database", reason: "not-accessible" });
        skippedDbHosts.add(oldHost);
        continue;
      }
      if (!dv.canWrite || !dv.internalHost) {
        skipped.push({ itemRef: t.itemRef, kind: "database", reason: "no-credentials" });
        skippedDbHosts.add(oldHost);
        continue;
      }
      dbInfos.push({ itemRef: t.itemRef, oldHost, dv });
    }

    // Decide each DB's mode from reality. Gather the old creds from EVERY app URL that points at it: preserve
    // only when there is exactly ONE distinct credential set across all apps AND it matches the Tugra DB's
    // current creds; a mismatch, or apps that disagree, falls to rotate (every URL rewritten to the one Tugra
    // credential) and leaves the old identity ambiguous so split vars are reported, never half-rewritten.
    const DB_NAME_ENGINES = new Set(["POSTGRES", "MYSQL", "MARIADB"]); // engines whose URL path is the db-name (not a redis index / mongo params)
    const targets: DbRemapTarget[] = dbInfos.map(({ itemRef, oldHost, dv }) => {
      const distinct = new Map<string, { user?: string; password?: string; database?: string }>();
      for (const a of appEnvs) {
        for (const v of Object.values(a.env)) {
          const c = credsFromUrlForHost(v, oldHost);
          if (c) distinct.set(`${c.user ?? ""}\u0000${c.password ?? ""}\u0000${c.database ?? ""}`, c);
        }
      }
      const rec = distinct.size === 1 ? [...distinct.values()][0] : undefined; // >1 distinct → ambiguous → undefined
      const preserve = !!rec && rec.user === dv.username && rec.password === dv.password && (rec.database === undefined || rec.database === dv.database);
      return {
        itemRef,
        name: dv.name,
        engine: dv.engine,
        mode: preserve ? "preserve" : "rotate",
        oldHost,
        newHost: dv.internalHost!,
        newPort: dv.port,
        newUser: dv.username ?? "",
        newPassword: dv.password ?? "",
        newDatabase: dv.database ?? "",
        oldUser: rec?.user,
        // only pg/mysql/mariadb carry a db-NAME in the URL path; a redis /index or mongo params must not be
        // treated as a db-name (else a REDIS_DB=0 split var would be rewritten to the Tugra slug).
        oldDatabase: DB_NAME_ENGINES.has(dv.engine) ? rec?.database : undefined,
        oldPassword: rec?.password,
      };
    });
    const appTargets: AppRemapTarget[] = appEnvs.map((a) => ({ itemRef: a.itemRef, name: a.name, oldHost: sourceRefOf(a.itemRef) ?? "\u0000none", newHost: `tugra_${a.appId}` }));

    // Raw per-app rewrites ({key,newValue}) the apply writer sets — NEVER returned to a client (secret values).
    const writes: Array<{ appId: string; name: string; itemRef: string; entries: Array<{ key: string; newValue: string }> }> = [];
    // Pass 1 (sync): run the pure engine per app; collect the public diff + the DBs each app references.
    const prepped = appEnvs.map((a) => {
      const res = remapEnv(a.env, { dbs: targets, apps: appTargets.filter((at) => at.itemRef !== a.itemRef), ...(hostShape ? { hostShape, bareHostKeyGate: true } : {}), ...(sourceServices?.length ? { services: sourceServices } : {}) });
      writes.push({ appId: a.appId, name: a.name, itemRef: a.itemRef, entries: res.changes.map((c) => ({ key: c.key, newValue: c.newValue })) });
      const needsManual = res.needsManual.map((n) => ({ key: n.key, reason: n.reason, targetItemRef: n.target }));
      // A value that references a DB we could NOT load looks "unchanged" but actually needs this DB — surface
      // it so an app is never shown as cleanly remapped while a referenced destination was skipped.
      let unchangedCount = res.unchanged.length;
      if (skippedDbHosts.size) {
        for (const key of res.unchanged) {
          const v = a.env[key];
          if ([...skippedDbHosts].some((h) => v.includes(h))) {
            needsManual.push({ key, reason: "target-unavailable", targetItemRef: undefined });
            unchangedCount--;
          }
        }
      }
      // The migrated DBs this app's automatic rewrites point at — the apps that may need the DB network.
      const refDbs = [...new Set(res.changes.filter((c) => c.target.kind === "database").map((c) => c.target.itemRef))].sort();
      return {
        itemRef: a.itemRef,
        appId: a.appId,
        name: a.name,
        changes: res.changes.map((c) => ({
          key: c.key,
          rule: c.rule,
          targetItemRef: c.target.itemRef,
          targetName: c.target.name,
          targetKind: c.target.kind,
          oldMasked: c.oldMasked,
          newMasked: c.newMasked,
          confidence: c.confidence,
        })),
        unchangedCount,
        needsManual,
        refDbs,
      };
    });

    // S4d-4 link eligibility (best-effort preview; setDbNetwork re-validates authoritatively at apply). An app
    // whose rewrites point at a migrated DB may also need to join the node-local DB network (tugra-net) so it
    // resolves tugra_db_<id>. Eligible only for a co-located classic topology; an ineligible app still gets its
    // env rewritten but is flagged needs-manual (it won't connect until networking is wired by hand).
    const candidateIds = prepped.filter((p) => p.refDbs.length > 0).map((p) => p.appId);
    const rows = candidateIds.length
      ? await this.prisma.application.findMany({
          where: { id: { in: candidateIds } },
          select: { id: true, serverId: true, clusterId: true, source: true, dockerOptions: true, dbNetwork: true },
        })
      : [];
    const rowById = new Map(rows.map((r) => [r.id, r]));
    // Exposure disclosure: a linked app can reach EVERY managed DB on the server (tugra-net is shared), and
    // libSQL has no auth — count/flag them so the operator confirms an informed blast radius. Only queried
    // when there IS a candidate app (nothing references a DB otherwise).
    const serverDbs = candidateIds.length
      ? await this.prisma.database.findMany({ where: { serverId: server.id, teamId: server.teamId }, select: { engine: true } })
      : [];
    const serverDbCount = serverDbs.length;
    const hasUnauthEngine = serverDbs.some((d) => d.engine === "LIBSQL");

    const links: Array<{ appId: string; eligible: boolean; dbNetworkPrior: boolean }> = [];
    const apps = prepped.map((p) => {
      const { refDbs, ...pubApp } = p;
      let dbNetwork: { willLink: boolean; reason?: string; databases: string[]; serverDbCount: number; hasUnauthEngine: boolean } | null = null;
      if (refDbs.length > 0) {
        const row = rowById.get(p.appId);
        let reason: string | undefined;
        if (!row) reason = "app-unavailable";
        else if (row.clusterId) reason = "swarm";
        else if (row.source === "COMPOSE") reason = "compose";
        else if (row.serverId !== server.id) reason = "cross-host";
        else if (tokenizeDockerOptions(row.dockerOptions).some((t) => /^(--network|--net)(=|$)/.test(t))) reason = "dockerOptions-network";
        else if (serverDbCount === 0) reason = "no-database"; // mirror setDbNetwork's guard so preview + gate agree
        const eligible = reason === undefined;
        links.push({ appId: p.appId, eligible, dbNetworkPrior: !!row?.dbNetwork });
        dbNetwork = { willLink: eligible, reason, databases: refDbs, serverDbCount, hasUnauthEngine };
        if (!eligible) pubApp.needsManual.push({ key: "(db-network)", reason: "dbnet-unsupported-topology", targetItemRef: undefined });
      }
      return { ...pubApp, dbNetwork };
    });

    // A canonical, SECRET-FREE planHash — the confirmToken the apply step re-computes + requires. It covers the
    // diff AND the link decision (willLink + referenced DBs + the server's DB count), so a drift in the network
    // link set — not just the env diff — forces the operator to re-review (apply returns 409).
    const canonical = JSON.stringify({
      opId,
      apps: apps
        .map((a) => ({
          id: a.appId,
          c: a.changes.map((c) => [c.key, c.rule, c.targetItemRef, c.newMasked]).sort(),
          l: a.dbNetwork ? [a.dbNetwork.willLink, a.dbNetwork.databases, a.dbNetwork.serverDbCount, a.dbNetwork.hasUnauthEngine] : null,
        }))
        .sort((x, y) => x.id.localeCompare(y.id)),
    });
    const planHash = createHash("sha256").update(canonical).digest("hex");

    const pub = {
      opId,
      planHash,
      databases: targets.map((t) => ({ itemRef: t.itemRef, name: t.name, engine: t.engine, mode: t.mode })),
      skipped,
      apps,
      note: "read-only preview — nothing has been changed; review the diff, then apply (a confirm-gated step) to write it",
    };
    return { op, pub, writes, links };
  }

  /**
   * Apply the previewed env-remap (S4d-3) — the FIRST write of the remap flow, fully confirm-gated. It
   * re-computes the SAME plan the preview showed and REFUSES (409) unless `confirmToken` equals that fresh
   * planHash, so any change to the source or the apps' env since the operator reviewed it aborts the write
   * rather than applying a stale diff. For a RELIABLE one-call undo it snapshots every app's prior env
   * (encrypted at rest, same key as everything else — no new exposure) and PERSISTS that undo record BEFORE
   * the first write, as an atomic compare-and-set on op.meta (so two overlapping applies can never both
   * commit and clobber the baseline, and sibling meta keys are never lost to a stale overwrite). Each app's
   * rewrites are then MERGED into a FRESH read of its env (unrelated keys preserved) via the writer-gated
   * {@link ApplicationsService.setEnv}; because the undo record is already committed, even a mid-loop write
   * failure stays fully reversible. Guards: a prior un-undone apply, and a plan with no automatic rewrites,
   * are both refused. Env changes take effect on an app's NEXT deploy — the response says so per app.
   */
  async remapEnvApply(userId: string, opId: string, confirmToken: string) {
    const { op, pub, writes, links } = await this.computeRemapPlan(userId, opId);
    if (pub.planHash !== confirmToken) {
      throw new ConflictException("the plan has changed since you reviewed it — re-open the preview and confirm the new plan");
    }
    if (hasPendingRemap(op.meta)) {
      throw new ConflictException("an env-remap has already been applied for this import — undo it first to re-apply");
    }
    const toWrite = writes.filter((w) => w.entries.length > 0);
    if (toWrite.length === 0) {
      throw new ConflictException("nothing to apply — the preview proposed no automatic rewrites");
    }
    // Apps the preview judged eligible to ALSO join the DB network → appId -> its prior dbNetwork flag (for undo).
    const linkPrior = new Map(links.filter((l) => l.eligible).map((l) => [l.appId, l.dbNetworkPrior]));

    // 1) Snapshot each target's CURRENT env first (fresh, writer-gated). An app we cannot read now (deleted or
    //    no longer writable since the plan) is skipped+reported — never written, never half-snapshotted.
    const undoApps: Array<{ appId: string; name: string; priorEnc: string; keys: string[]; dbNetworkPrior?: boolean }> = [];
    const targets: Array<{ appId: string; name: string; prior: Record<string, string>; entries: Array<{ key: string; newValue: string }> }> = [];
    const unprepared: Array<{ appId: string; name: string }> = [];
    for (const w of toWrite) {
      let prior: Record<string, string>;
      try {
        prior = await this.apps.getEnv(userId, w.appId);
      } catch {
        unprepared.push({ appId: w.appId, name: w.name });
        continue;
      }
      // Record a link-reversal in the undo snapshot ONLY when the apply actually flips the flag (prior false →
      // true). If the app was ALREADY linked (prior true), the apply is a no-op on the flag, so undo must not
      // touch it — and recording only the false case means undo only ever calls setDbNetwork(false), the
      // guard-free direction that cannot throw a topology error and strand the record. Committed before any write.
      const linkEntry = linkPrior.get(w.appId) === false ? { dbNetworkPrior: false } : {};
      undoApps.push({ appId: w.appId, name: w.name, priorEnc: this.crypto.encrypt(JSON.stringify(prior)), keys: w.entries.map((e) => e.key), ...linkEntry });
      targets.push({ appId: w.appId, name: w.name, prior, entries: w.entries });
    }
    if (targets.length === 0) {
      throw new ConflictException("no apps could be prepared for the remap (deleted or no longer writable)");
    }

    // 2) COMMIT the undo record BEFORE any write, as an atomic compare-and-set on op.meta (see casMeta): it
    //    applies only if meta is still what the guard just saw, so two overlapping applies can never both
    //    commit an undo record, and sibling meta keys (hubBase/rolledBackAt) are never lost to a stale write.
    const before = await this.freshMeta(opId);
    if (hasPendingRemap(before)) {
      throw new ConflictException("another env-remap apply is in progress or already applied — re-open the preview");
    }
    await this.casMeta(opId, before, { ...before, remapUndo: { appliedAt: new Date().toISOString(), planHash: pub.planHash, apps: undoApps } });

    // 3) Write. The undo record already covers every target, so a per-app failure here stays reversible. Each
    //    write MERGES onto a FRESH read of the app's env, so an edit landing since the snapshot is preserved.
    //    For an eligible app we then ALSO link the DB network — setDbNetwork re-validates (the authoritative
    //    gate); a link failure is reported but never discards the successful env write.
    const appliedApps: Array<{ appId: string; name: string; written: number; keys: string[]; needsRedeploy: boolean; linked: boolean }> = [];
    const failed: Array<{ appId: string; name: string }> = [...unprepared];
    const linkFailed: Array<{ appId: string; name: string }> = [];
    for (const t of targets) {
      try {
        const current = await this.apps.getEnv(userId, t.appId); // fresh — unrelated edits since the snapshot kept
        const next = { ...current };
        for (const e of t.entries) next[e.key] = e.newValue;
        await this.apps.setEnv(userId, t.appId, next); // writer-gated + audited + encrypted at rest
        let linked = false;
        if (linkPrior.has(t.appId)) {
          try {
            await this.apps.setDbNetwork(userId, t.appId, true); // re-validates topology; takes effect next deploy
            linked = true;
          } catch {
            linkFailed.push({ appId: t.appId, name: t.name }); // env is written; only the network link failed
          }
        }
        appliedApps.push({ appId: t.appId, name: t.name, written: t.entries.length, keys: t.entries.map((e) => e.key), needsRedeploy: true, linked });
      } catch {
        failed.push({ appId: t.appId, name: t.name }); // reversible via undo — the snapshot was committed above
      }
    }
    await this.audit.log({ actor: userId, action: "import.remap_env.apply", target: opId, meta: { applied: appliedApps.map((a) => ({ appId: a.appId, keys: a.keys, linked: a.linked })), failed: failed.map((f) => f.appId), linkFailed: linkFailed.map((f) => f.appId) } });
    return {
      opId,
      applied: failed.length === 0 && linkFailed.length === 0,
      planHash: pub.planHash,
      apps: appliedApps,
      failed,
      linkFailed,
      note: "env rewritten to point at the new Tugra databases (eligible apps also joined the DB network) — redeploy each app for the changes to take effect; an undo is available",
    };
  }

  /**
   * Reverse a {@link remapEnvApply} (S4d-3): revert the keys the remap rewrote back to the snapshot taken
   * before it wrote them. For each app it fresh-reads the CURRENT env and reverts ONLY the remapped keys
   * (restoring a key's prior value, or deleting it if it was absent before), so env edits made after the
   * apply are kept — never a blind whole-env replace. The record is marked consumed ONLY when every app
   * restored: an app that no longer exists is dropped (nothing to restore), while a transient per-app
   * failure keeps that app in the record (un-undone) so undo can be retried and a re-apply stays blocked.
   * Reuses the preview/apply gate (assertCanMigrate → apps:config); refuses (409) when nothing is applied.
   */
  async remapEnvUndo(userId: string, opId: string) {
    const op = await this.loadOwnedOp(userId, opId, { reapData: false });
    await this.assertCanMigrate(userId, op);
    const before = metaObj(op.meta); // the meta `undo` is read from — also the compare-and-set precondition below
    const undo = readRemapUndo(before);
    if (!undo || undo.undoneAt || !undo.apps?.length) {
      throw new ConflictException("nothing to undo — no env-remap has been applied for this import");
    }
    const restored: Array<{ appId: string; name: string }> = [];
    const terminal: Array<{ appId: string; name: string; reason: string }> = []; // can never be restored → dropped, not retried forever
    const stillFailed: typeof undo.apps = []; // a TRANSIENT failure — kept so undo can be retried
    for (const a of undo.apps) {
      let prior: Record<string, string>;
      try {
        prior = JSON.parse(this.crypto.decrypt(a.priorEnc)) as Record<string, string>;
      } catch {
        terminal.push({ appId: a.appId, name: a.name, reason: "snapshot-unreadable" }); // corrupt ciphertext — retrying can't help
        continue;
      }
      try {
        const current = await this.apps.getEnv(userId, a.appId);
        const next = { ...current };
        for (const k of a.keys ?? Object.keys(prior)) {
          if (Object.prototype.hasOwnProperty.call(prior, k)) next[k] = prior[k];
          else delete next[k]; // the remap had ADDED this key — reverting means removing it
        }
        await this.apps.setEnv(userId, a.appId, next); // key-scoped revert — post-apply edits to other keys kept
        // Reverse the DB-network link too (only for an app the apply linked) — restore its prior flag.
        if (a.dbNetworkPrior !== undefined) await this.apps.setDbNetwork(userId, a.appId, a.dbNetworkPrior);
        restored.push({ appId: a.appId, name: a.name });
      } catch (e) {
        if (e instanceof NotFoundException) terminal.push({ appId: a.appId, name: a.name, reason: "app-deleted" });
        else if (e instanceof ForbiddenException) terminal.push({ appId: a.appId, name: a.name, reason: "not-writable" });
        else stillFailed.push(a); // transient (e.g. a DB blip) — keep for a retry
      }
    }
    // Consume the record ONLY when nothing transient remains: a terminal app (deleted/unwritable/corrupt) is
    // dropped so a re-apply is never blocked forever; a transient app is kept (un-undone) so undo can retry.
    // On full consumption the encrypted priorEnc snapshots are dropped from meta (hygiene — no secret lingers).
    const after = {
      ...before,
      remapUndo: stillFailed.length
        ? { ...undo, apps: stillFailed, partialUndoAt: new Date().toISOString() }
        : { appliedAt: undo.appliedAt, planHash: undo.planHash, undoneAt: new Date().toISOString(), apps: [] },
    };
    await this.casMeta(opId, before, after);
    await this.audit.log({ actor: userId, action: "import.remap_env.undo", target: opId, meta: { restored: restored.map((r) => r.appId), terminal: terminal.map((t) => ({ appId: t.appId, reason: t.reason })), failed: stillFailed.map((f) => f.appId) } });
    return {
      opId,
      undone: stillFailed.length === 0,
      apps: restored,
      failed: [...terminal.map((t) => ({ appId: t.appId, name: t.name })), ...stillFailed.map((f) => ({ appId: f.appId, name: f.name }))],
      note: stillFailed.length
        ? "reverted the remapped keys for the apps that could be written; some remain pending (a transient failure) — retry undo"
        : "reverted the remapped keys to the pre-remap snapshot (other env edits kept); redeploy to apply the reverted env",
    };
  }

  /** Re-read op.meta from the DB as a fresh mutable object, so a remap commit merges onto the CURRENT meta
   *  (never a stale copy that would lose a sibling key like hubBase/rolledBackAt). */
  private async freshMeta(opId: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { meta: true } });
    return metaObj(row?.meta);
  }

  /** Compare-and-set op.meta: write `after` ONLY while the row's meta still equals `before` (Postgres jsonb
   *  value equality — order-independent). A concurrent writer that changed meta first makes this match no row
   *  (count 0) → 409, so two overlapping remap applies/undos can never both commit and clobber the baseline. */
  private async casMeta(opId: string, before: Record<string, unknown>, after: Record<string, unknown>): Promise<void> {
    const claim = await this.prisma.bulkOperation.updateMany({
      where: { id: opId, meta: { equals: before as Prisma.InputJsonValue } },
      data: { meta: after as Prisma.InputJsonValue },
    });
    if (claim.count !== 1) {
      throw new ConflictException("the operation was modified concurrently — re-open the preview and confirm again");
    }
  }

  /**
   * A migration token authorizes an untrusted host to stream DATA into the op's provisioned resources, so
   * minting is gated to the one state where that is meaningful AND safe: a COPY-mode (coolify) import whose
   * apply has settled with at least one real destination (a DONE app/db resource), that has not been
   * cancelled or rolled back, and whose creator still holds apps:config on the target team. local-docker
   * adopts live containers in place (no empty dest to restore into), a still-running apply has no dest yet,
   * and a rolled-back op's resources are gone — none may mint. (Removing the spec's backwards "finished →
   * 409" gate was right; this replaces it with the correct positive condition.)
   */
  private async assertCanMigrate(
    userId: string,
    op: { meta: unknown; cancelRequestedAt: Date | null; tasks: Array<{ status: string; kind?: string; itemRef?: string | null; resourceType: string | null; resourceId: string | null }> },
  ): Promise<void> {
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { sourceKind?: string; serverId?: string; rolledBackAt?: string }) : {};
    if (!COPY_MODE_KINDS.has(meta.sourceKind ?? "")) throw new ConflictException("only a copy-mode (remote-source) import can migrate data");
    if (op.cancelRequestedAt) throw new ConflictException("operation was cancelled");
    if (meta.rolledBackAt) throw new ConflictException("operation was rolled back");
    if (!meta.serverId) throw new ConflictException("operation has no target server");
    // A streamed volume copy runs for hours: it must not stop the owner from reissuing the token that resumes it.
    if (deriveOpStatus(op.tasks.filter((t) => !isVxDataTask(t)).map((t) => t.status as TaskStatus)) === "RUNNING") {
      throw new ConflictException("the import is still running — wait for it to finish before migrating data");
    }
    const hasDest = op.tasks.some((t) => t.status === "DONE" && (t.resourceType === "application" || t.resourceType === "database") && !!t.resourceId);
    if (!hasDest) throw new ConflictException("the import provisioned no resources to migrate data into");
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
  }

  /**
   * Load an op for the migration INGEST path (authenticated by the migration token, not a user session, so it
   * takes actorId instead of userId and does NO permission call — the ingest service re-authorizes per item).
   * Same reaper + ownership + copy-mode eligibility as the mint gate, but tolerant of in-flight `data` tasks
   * (the restore we are driving): it blocks only while the APPLY provisioning (app/db tasks) is still running.
   */
  async loadIngestOp(opId: string, actorId: string) {
    // Reap stale APPLY tasks only — never a `data` task: this runs on every ingest request (incl. status
    // polls), and a legit long restore must not be killed mid-flight (the restore claim handles its own
    // stale-takeover, and S6 adds a heartbeat/longer threshold for data tasks).
    await this.prisma.bulkTask.updateMany({
      where: { opId, kind: { not: "data" }, status: "RUNNING", startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      data: { status: "FAILED", output: "stale: no completion signal (the worker stopped before finishing)", finishedAt: new Date() },
    });
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, include: { tasks: { orderBy: { itemRef: "asc" } } } });
    if (!op || op.kind !== "import") throw new NotFoundException("import operation not found");
    if (op.actorId !== actorId) throw new ForbiddenException("not your operation");
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { sourceKind?: string; serverId?: string; rolledBackAt?: string }) : {};
    if (!COPY_MODE_KINDS.has(meta.sourceKind ?? "")) throw new ConflictException("only a copy-mode (remote-source) import can migrate data");
    if (op.cancelRequestedAt) throw new ConflictException("operation was cancelled");
    if (meta.rolledBackAt) throw new ConflictException("operation was rolled back");
    if (!meta.serverId) throw new ConflictException("operation has no target server");
    // Only the provisioning tasks gate readiness; a RUNNING `data` task is the ingest in progress, not the apply.
    const provisioning = op.tasks.filter((t) => t.kind !== "data").map((t) => t.status as TaskStatus);
    if (deriveOpStatus(provisioning) === "RUNNING") throw new ConflictException("the import is still running — wait for it to finish before migrating data");
    if (!op.tasks.some((t) => t.status === "DONE" && (t.resourceType === "application" || t.resourceType === "database") && !!t.resourceId)) {
      throw new ConflictException("the import provisioned no resources to migrate data into");
    }
    return op;
  }

  /** The owned import op for the SSL/DNS cutover module (read-mostly: never reaps an in-flight `data` restore). */
  async ownedOpForCutover(userId: string, opId: string) {
    return this.loadOwnedOp(userId, opId, { reapData: false });
  }

  private async loadOwnedOp(userId: string, opId: string, opts: { reapData?: boolean } = {}) {
    // Lazily settle tasks stuck RUNNING past the stale threshold — a worker that died or a hub restart mid-
    // adopt would otherwise leave the operation reading RUNNING forever and block rollback. Bounded: only
    // touches genuinely-stale rows (the adopt path's own timeouts are well under a minute). `reapData:false`
    // (used by the read-only remap preview) leaves in-flight `data` restore tasks alone, so a preview can
    // never kill a long migration the way a mutating caller's reaper would.
    const reapData = opts.reapData !== false;
    await this.prisma.bulkTask.updateMany({
      where: {
        opId,
        ...(reapData ? {} : { kind: { not: "data" } }),
        // A streamed volume copy (data:volume:*) runs for hours: ONLY its own heartbeat sweep (VxRecoveryService) may
        // settle it, never this 10-minute reaper. (OR keeps rows with a NULL itemRef reapable: SQL NOT(NULL) is NULL.)
        OR: [{ itemRef: null }, { NOT: { itemRef: { startsWith: VX_DATA_PREFIX } } }],
        status: "RUNNING",
        startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) },
      },
      data: { status: "FAILED", output: "stale: no completion signal (the worker stopped before finishing)", finishedAt: new Date() },
    });
    const op = await this.prisma.bulkOperation.findUnique({
      where: { id: opId },
      include: { tasks: { orderBy: { itemRef: "asc" } } },
    });
    if (!op || op.kind !== "import") throw new NotFoundException("import operation not found");
    if (op.actorId !== userId) throw new ForbiddenException("not your operation");
    return op;
  }
}

/** The target project/environment tree built for one import apply (see {@link ImportExecutorService.buildImportTree}). */
interface ImportTree {
  envByRef: Map<string, Map<string, string>>; // source projectRef → (source environmentRef → Tugra environmentId)
  summary: Array<{ project: string; projectCreated: boolean; environments: string[]; environmentsCreated: string[] }>;
  warnings: string[];
  /** Under an editable mapping: itemRef → the Tugra environmentId its resolved (project, environment) maps to. */
  envByItemRef?: Map<string, string>;
}

/** The secret-free snapshot of the applied mapping stored on op.meta: names and placement only, so later profile
 *  edits never affect an in-flight or finished op. */
function mappingSnapshot(res: ResolvedMapping, reconcile: boolean) {
  return {
    hash: res.mappingHash,
    renamed: res.counts.renamed,
    moved: res.counts.moved,
    excluded: res.counts.excluded,
    aliased: res.counts.aliased,
    reconcile,
    effective: res.effective.map((e) => ({ itemRef: e.itemRef, name: e.name, sourceName: e.sourceName, project: e.project, environment: e.environment })),
  };
}

/** A fixed reason (never the error text) for a container alias the apply could not set. */
function aliasFailureReason(e: unknown): "reserved" | "taken" | "unsupported" | "other" {
  const m = e instanceof Error ? e.message : "";
  if (/reserved/i.test(m)) return "reserved";
  if (/already in use|alias already/i.test(m)) return "taken";
  if (/compose|swarm|clustered|preview|--network|aren't supported|not supported/i.test(m)) return "unsupported";
  return "other";
}

/** The Tugra environmentId for a resource's source project/environment, or undefined when it carries no
 *  (resolvable) refs — Coolify / local-docker, or a Dokploy resource with no ref — so the caller falls back to
 *  the single selected environment. */
function resolveTreeEnvironment(envByRef: ReadonlyMap<string, ReadonlyMap<string, string>>, res: { projectRef?: string; environmentRef?: string } | undefined): string | undefined {
  if (!res?.projectRef || !res.environmentRef) return undefined;
  return envByRef.get(res.projectRef)?.get(res.environmentRef);
}

/** The encrypted env-remap undo record stashed on op.meta by {@link ImportExecutorService.remapEnvApply}. */
interface RemapUndoRecord {
  appliedAt?: string;
  undoneAt?: string;
  partialUndoAt?: string;
  planHash?: string;
  apps?: Array<{ appId: string; name: string; priorEnc: string; keys?: string[]; dbNetworkPrior?: boolean }>;
}

/** A Prisma Json value as a fresh mutable object ({} when null/absent), safe to merge onto. */
function metaObj(meta: unknown): Record<string, unknown> {
  return typeof meta === "object" && meta ? { ...(meta as Record<string, unknown>) } : {};
}

/** The op's remap undo record, or undefined. */
function readRemapUndo(meta: unknown): RemapUndoRecord | undefined {
  const m = typeof meta === "object" && meta ? (meta as { remapUndo?: RemapUndoRecord }) : {};
  return m.remapUndo;
}

/** True when a remap has been applied and not yet fully undone — the re-apply guard. */
function hasPendingRemap(meta: unknown): boolean {
  const undo = readRemapUndo(meta);
  return !!undo && !undo.undoneAt;
}

/** The source-side reference (a Coolify resource uuid) from an itemRef `<kind>:<serverRef|_>:<sourceRef>`
 *  (import-planner ns()). Everything after the 2nd ':' — kind-agnostic (database: / app:). */
function sourceRefOf(itemRef: string): string | undefined {
  const i1 = itemRef.indexOf(":");
  if (i1 < 0) return undefined;
  const i2 = itemRef.indexOf(":", i1 + 1);
  if (i2 < 0) return undefined;
  const ref = itemRef.slice(i2 + 1);
  return ref.length ? ref : undefined;
}

/** Defensively read a persisted `{applied, unmapped}` summary: arrays of strings / {field, reason} strings only (plus a
 *  known `reasonCode` and its string/number `reasonParams` when present), anything else is dropped. Rows persisted before
 *  the codes existed have none and keep their English `reason`. Undefined when absent or malformed. */
function readApplyReport(v: unknown): { applied: string[]; unmapped: Unmapped[] } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as { applied?: unknown; unmapped?: unknown };
  const applied = Array.isArray(r.applied) ? r.applied.filter((x): x is string => typeof x === "string") : [];
  const unmapped: Unmapped[] = Array.isArray(r.unmapped)
    ? r.unmapped
        .filter((u): u is Record<string, unknown> & { field: string; reason: string } => !!u && typeof u === "object" && typeof (u as { field?: unknown }).field === "string" && typeof (u as { reason?: unknown }).reason === "string")
        .map((u) => {
          const code = (IMPORT_REASON_CODES as readonly unknown[]).includes(u.reasonCode) ? (u.reasonCode as ImportReasonCode) : undefined;
          const params = u.reasonParams && typeof u.reasonParams === "object" ? Object.fromEntries(Object.entries(u.reasonParams).filter(([, x]) => typeof x === "string" || typeof x === "number")) : undefined;
          return { field: u.field, reason: u.reason, ...(code ? { reasonCode: code } : {}), ...(code && params && Object.keys(params).length ? { reasonParams: params as Record<string, string | number> } : {}) };
        })
    : [];
  return { applied, unmapped };
}

/** Defensively read a persisted list of key NAMES: strings only, capped. Undefined when absent/empty. */
function readNameList(v: unknown, cap = 50): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string").slice(0, cap).map((x) => x.slice(0, 128));
  return out.length ? out : undefined;
}

const GIT_STATUSES = new Set(["linked", "public_ok", "needs_source", "ambiguous", "ssh_deploy_key", "unsupported_host", "unknown"]);
/** Defensively read a task's persisted git outcome (status + source NAME + the PUBLIC deploy key only). */
function readGitResult(v: unknown): { status: string; sourceName?: string; rewritten?: boolean; deployKeyPublic?: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as { status?: unknown; sourceName?: unknown; rewritten?: unknown; deployKeyPublic?: unknown };
  if (typeof r.status !== "string" || !GIT_STATUSES.has(r.status)) return undefined;
  return {
    status: r.status,
    ...(typeof r.sourceName === "string" ? { sourceName: r.sourceName.slice(0, 120) } : {}),
    ...(r.rewritten === true ? { rewritten: true } : {}),
    ...(typeof r.deployKeyPublic === "string" && /^ssh-[a-z0-9-]+ [A-Za-z0-9+/=]+/.test(r.deployKeyPublic) ? { deployKeyPublic: r.deployKeyPublic.slice(0, 600) } : {}),
  };
}

/** The secret-free summary of an applied SERVICE task, read defensively from the persisted result: only the known fields,
 *  only strings / numbers / booleans / arrays of them. Undefined for a non-service task. */
export interface ServiceTaskView {
  members: string[];
  dropped: Array<{ field: string; reason: string }>;
  configMounts: number;
  serviceDomains: { applied: number; unmapped: Array<{ field: string; reason: string }> };
  privateNetwork?: { network: string; alias: string };
  volumes: Array<{ key: string; dockerName: string; policy: string; dataPlane: string; state: string }>;
  hold: boolean;
  checklist: Array<{ kind: string; severity: "info" | "warn"; params: Record<string, string | number | string[]> }>;
  /** The ordered steps the task recorded (prepare, create, domains, config-files, volumes, done) with their state. */
  steps: Array<{ name: string; status: string }>;
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const reasons = (v: unknown): Array<{ field: string; reason: string }> =>
  Array.isArray(v) ? v.filter((u): u is { field: string; reason: string } => !!u && typeof u === "object" && typeof (u as { field?: unknown }).field === "string" && typeof (u as { reason?: unknown }).reason === "string").map((u) => ({ field: u.field, reason: u.reason })) : [];
function readServiceResult(v: unknown, steps?: unknown): ServiceTaskView | undefined {
  if (!v || typeof v !== "object" || (v as { kind?: unknown }).kind !== "service") return undefined;
  const r = v as Record<string, unknown>;
  const sd = (r.serviceDomains && typeof r.serviceDomains === "object" ? r.serviceDomains : {}) as { applied?: unknown; unmapped?: unknown };
  const pn = r.privateNetwork as { network?: unknown; alias?: unknown } | undefined;
  const volumes = Array.isArray(r.volumes)
    ? r.volumes
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({ key: String(x.key ?? ""), dockerName: String(x.dockerName ?? ""), policy: String(x.policy ?? ""), dataPlane: String(x.dataPlane ?? ""), state: String(x.state ?? "") }))
    : [];
  const checklist = Array.isArray(r.checklist)
    ? r.checklist
        .filter((x): x is { kind: string; severity: string; params: Record<string, unknown> } => !!x && typeof x === "object" && typeof (x as { kind?: unknown }).kind === "string")
        .map((x) => ({
          kind: x.kind,
          severity: (x.severity === "warn" ? "warn" : "info") as "info" | "warn",
          params: Object.fromEntries(Object.entries(x.params && typeof x.params === "object" ? x.params : {}).filter(([, val]) => typeof val === "string" || typeof val === "number" || (Array.isArray(val) && val.every((e) => typeof e === "string")))) as Record<string, string | number | string[]>,
        }))
    : [];
  return {
    members: strs(r.members),
    dropped: reasons(r.dropped),
    configMounts: typeof r.configMounts === "number" ? r.configMounts : 0,
    serviceDomains: { applied: typeof sd.applied === "number" ? sd.applied : 0, unmapped: reasons(sd.unmapped) },
    ...(pn && typeof pn.network === "string" && typeof pn.alias === "string" ? { privateNetwork: { network: pn.network, alias: pn.alias } } : {}),
    volumes,
    hold: r.hold === true,
    checklist,
    steps: Array.isArray(steps) ? steps.filter((x): x is { name: string; status: string } => !!x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" && typeof (x as { status?: unknown }).status === "string").map((x) => ({ name: x.name, status: x.status })) : [],
  };
}

/** Shape the owned operation into a secret-free status view (internal compensation is not exposed). Includes
 *  the persisted plan snapshot so a failed/partial import's full picture survives for a post-mortem. */
export function toStatusView(op: {
  id: string;
  planId: string | null;
  meta: unknown;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  tasks: Array<{
    itemRef: string | null;
    kind: string;
    status: string;
    resourceType: string | null;
    resourceId: string | null;
    result: unknown;
    output: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
  }>;
}) {
  // Streamed volume copies (hours) are shown on their own panel; they must not keep the IMPORT reading "running" (which would
  // hide the post-import steps while the data moves). v1 data tasks (short restores) keep counting exactly as before.
  const counted = op.tasks.filter((t) => !isVxDataTask(t));
  const statuses = counted.map((t) => t.status as TaskStatus);
  const count = (s: TaskStatus) => statuses.filter((x) => x === s).length;
  const meta = typeof op.meta === "object" && op.meta ? (op.meta as { sourceKind?: string; serverId?: string; plan?: unknown }) : {};
  return {
    id: op.id,
    sourceKind: meta.sourceKind ?? null,
    serverId: meta.serverId ?? null,
    planHash: op.planId,
    // The secret-free plan captured at apply time — the durable record of what the import discovered +
    // intended, independent of any later re-discovery. Null for legacy ops that predate this.
    plan: meta.plan ?? null,
    status: deriveOpStatus(statuses),
    cancelRequested: !!op.cancelRequestedAt,
    createdAt: op.createdAt,
    totals: {
      total: counted.length,
      done: count("DONE"),
      failed: count("FAILED") + count("FAILED_VERIFY"),
      skipped: count("SKIPPED"),
      running: count("RUNNING"),
      pending: count("PENDING"),
      cancelled: count("CANCELLED"),
      rolledBack: count("ROLLED_BACK"),
    },
    tasks: op.tasks.map((t) => {
      const res = typeof t.result === "object" && t.result ? (t.result as { name?: string; sourceName?: string; mapped?: boolean; unresolvedEnv?: number; unresolvedKeys?: unknown; droppedInvalidKeys?: unknown; git?: unknown; postCreate?: unknown; ingress?: unknown }) : null;
      return {
        itemRef: t.itemRef,
        kind: t.kind,
        name: res?.name ?? null,
        // Under an editable mapping: the source-side name and a marker (additive; absent without a mapping).
        ...(typeof res?.sourceName === "string" ? { sourceName: res.sourceName } : {}),
        ...(res?.mapped === true ? { mapped: true } : {}),
        status: t.status,
        resourceType: t.resourceType,
        resourceId: t.resourceId,
        message: t.output,
        // Count only (never values): >0 means the app was created with some env vars unresolved — fix before deploy.
        unresolvedEnv: typeof res?.unresolvedEnv === "number" ? res.unresolvedEnv : undefined,
        // Strict-env (Coolify): the NAMES of the variables the app was created without (acknowledged). Never values.
        unresolvedKeys: readNameList(res?.unresolvedKeys),
        droppedInvalidKeys: readNameList(res?.droppedInvalidKeys),
        // Git link outcome of a git app (status, source name, public deploy key). Undefined for other tasks.
        git: readGitResult(res?.git),
        // What the app could not carry (field NAMES + fixed reasons only, never values). Undefined for a task without it.
        postCreate: readApplyReport(res?.postCreate),
        ingress: readApplyReport(res?.ingress),
        ...(res && (res as { kind?: unknown }).kind === "service" ? { service: readServiceResult(res, (t as { steps?: unknown }).steps) } : {}),
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
      };
    }),
  };
}
