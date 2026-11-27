import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, Role, type CoolifyCleanup, type Server } from "@prisma/client";
import type { CleanupRemnant, CleanupResult, CleanupStatus, CleanupView, CompletenessRow } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { ServersService } from "../servers/servers.service";
import { CryptoService } from "../crypto/crypto.service";
import { composeServiceNames, composeVolumes } from "../deploy/compose-script";
import type { CoolifyInventoryData } from "../coolify-takeover/coolify-inventory";
import { compareCompleteness, isComplete, type TugraApp, type TugraDb, type TugraSide } from "./completeness";
import { coolifyServerFor, coolifySideFor, withHostVolumes } from "./coolify-side";
import { buildScanScript, classifyScan, listHash, parseScan, removable, ScanError, type ScanResult } from "./remnant-scan";
import { DnsLookupService } from "../dns/dns-lookup.service";
import { NetProbe } from "../cutover/net-probe";
import { checkTraffic } from "./traffic-check";
import { buildRemoveScript, parseRemoveOutput } from "./remnant-remove";
import type { ConfirmInput } from "./dto";

const CAPABILITY = "coolify_cleanup" as const;
const SCAN_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 240_000;
/** A CHECKING or CLEANING row nobody finished (hub restarted) stops blocking a new check after this long. The removal is idempotent. */
const STALE_MS = 15 * 60_000;
/**
 * The stored Coolify read is trusted for this long. Items created in Coolify after the read are not in it (and so are never removed),
 * but a read older than this says too little about what is on the server now: the owner reads the Coolify again first.
 */
const READ_MAX_AGE_MS = 30 * 60_000;

const isInventory = (v: unknown): v is CoolifyInventoryData =>
  !!v && typeof v === "object" && (v as { v?: unknown }).v === 1 && Array.isArray((v as { servers?: unknown }).servers) && Array.isArray((v as { applications?: unknown }).applications);

const conflict = (code: string, message: string) => new ConflictException({ statusCode: 409, message, code });

const remnantsOf = (row: CoolifyCleanup): CleanupRemnant[] => (Array.isArray(row.remnants) ? (row.remnants as unknown as CleanupRemnant[]) : []);

/**
 * Coolify leftover cleanup and the completeness checklist (Coolify hub takeover, lane G).
 *
 * Flow: `check` (owner) compares every Coolify item on the server with its Tugra counterpart and lists what Coolify left there. Nothing is
 * removed. Only when the checklist is complete AND the owner then confirms the exact list (typing the server name and quoting the list's
 * fingerprint) does `confirm` remove it, and only what the allow-list names: a docker volume is never listed, never removed. The agent
 * work is a signed script under the `coolify_cleanup` capability, which the hub grants for the duration of each call and takes away again.
 * Team OWNER only; every step is audited with names and counts, never a value.
 */
@Injectable()
export class CoolifyCleanupService {
  private readonly log = new Logger(CoolifyCleanupService.name);
  /** Removals in flight in this process (tests await them through {@link settled}). */
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly servers: ServersService,
    private readonly crypto: CryptoService,
    private readonly dns: DnsLookupService,
    private readonly net: NetProbe,
  ) {}

  // ───────────────────────────── authorization ─────────────────────────────

  private async requireOwner(userId: string, teamId: string): Promise<void> {
    if ((await this.access.teamRole(userId, teamId)) !== Role.OWNER) throw new ForbiddenException("only a team owner can clean up Coolify");
  }

  private async requireViewer(userId: string, teamId: string): Promise<void> {
    const r = await this.access.teamRole(userId, teamId);
    if (r !== Role.OWNER && r !== Role.ADMIN) throw new ForbiddenException("only a team owner or admin can see this");
  }

  private async loadServer(serverId: string): Promise<Server> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!s) throw new NotFoundException("server not found");
    return s;
  }

  // ───────────────────────────── check ─────────────────────────────

  /** POST: compare, list, store. Removes nothing. */
  async check(userId: string, serverId: string): Promise<CleanupView> {
    const server = await this.loadServer(serverId);
    await this.requireOwner(userId, server.teamId);
    if (!this.agentWs.isOnline(serverId)) throw new AgentOfflineException();
    await this.assertNoActive(serverId);
    await this.assertServerFree(serverId);

    const row = await this.prisma.coolifyCleanup.create({ data: { teamId: server.teamId, serverId, actorId: userId, status: "CHECKING" } });
    await this.audit.log({ actor: userId, action: "coolify.cleanup.check", target: serverId, meta: { cleanupId: row.id } });
    try {
      const found = await this.resolveCoolify(userId, server);
      const raw = await this.scan(serverId);
      const { rows, complete, completeUuids } = await this.judge(server, found, raw);
      const scan = classifyScan(raw, { knownUuids: found.knownUuids, completeUuids });
      if (scan.controlPlane) return await this.finish(row.id, "FAILED", { completeness: rows, remnants: scan.remnants, failureCode: "control_plane" });
      const out = await this.finish(row.id, complete ? "READY" : "INCOMPLETE", { completeness: rows, remnants: scan.remnants });
      const gone = removable(scan.remnants).length;
      await this.audit.log({ actor: userId, action: "coolify.cleanup.scan", target: serverId, meta: { cleanupId: row.id, complete, removable: gone, kept: scan.remnants.length - gone } });
      return out;
    } catch (e) {
      if (e instanceof ConflictException) {
        await this.finish(row.id, "FAILED", { failureCode: String((e.getResponse() as { code?: string }).code ?? "conflict") });
        throw e;
      }
      if (e instanceof AgentOfflineException) {
        await this.finish(row.id, "FAILED", { failureCode: "agent_offline" });
        throw e;
      }
      this.log.warn(`cleanup check failed: ${e instanceof Error ? e.constructor.name : "unknown"}`);
      return this.finish(row.id, "FAILED", { failureCode: e instanceof ScanError ? (e.code === "no_docker" ? "no_docker" : "scan_unreadable") : "agent_error" });
    }
  }

  async get(userId: string, id: string): Promise<CleanupView> {
    const row = await this.loadRow(id);
    await this.requireViewer(userId, row.teamId);
    return this.toView(row);
  }

  /** The newest cleanup of a server, or null. */
  async latest(userId: string, serverId: string): Promise<CleanupView | null> {
    const server = await this.loadServer(serverId);
    await this.requireViewer(userId, server.teamId);
    const row = await this.prisma.coolifyCleanup.findFirst({ where: { serverId }, orderBy: { createdAt: "desc" } });
    return row ? this.toView(row) : null;
  }

  // ───────────────────────────── confirm and remove ─────────────────────────────

  /**
   * POST: the owner confirms the list they saw. Everything is re-checked first (a stale list or a checklist that is no longer complete
   * is refused); then the removal runs in the background and the view comes back as CLEANING.
   */
  async confirm(userId: string, id: string, input: ConfirmInput): Promise<CleanupView> {
    const row = await this.loadRow(id);
    await this.requireOwner(userId, row.teamId);
    if (row.status === "INCOMPLETE") throw conflict("incomplete", "something is still missing in Tugra: nothing can be removed");
    if (row.status !== "READY") throw conflict("not_ready", "this cleanup is not ready to confirm");
    const server = await this.loadServer(row.serverId);
    if (input.confirm !== server.name) throw new BadRequestException({ statusCode: 400, message: "type the server's exact name to confirm", code: "confirm_name_mismatch" });
    if (input.listHash !== listHash(remnantsOf(row))) throw conflict("list_changed", "the list changed: look at it again");
    if (!this.agentWs.isOnline(row.serverId)) throw new AgentOfflineException();
    // time has passed since the check: a takeover or a run may have started on the server in between
    await this.assertServerFree(row.serverId);

    // A fresh look: the checklist must still be complete and the list the very one the owner confirmed.
    const found = await this.resolveCoolify(userId, server);
    const knownUuids = found.knownUuids;
    const raw = await this.scan(row.serverId);
    const { rows, complete, completeUuids } = await this.judge(server, found, raw);
    const scan = classifyScan(raw, { knownUuids, completeUuids });
    if (scan.controlPlane) {
      await this.finish(row.id, "FAILED", { completeness: rows, remnants: scan.remnants, failureCode: "control_plane" });
      throw conflict("control_plane", "this server is the Coolify host: it is retired separately");
    }
    if (!complete) {
      await this.finish(row.id, "INCOMPLETE", { completeness: rows, remnants: scan.remnants });
      throw conflict("incomplete", "something is no longer complete in Tugra: nothing was removed");
    }
    if (listHash(scan.remnants) !== input.listHash) {
      await this.finish(row.id, "READY", { completeness: rows, remnants: scan.remnants });
      throw conflict("list_changed", "the list changed: look at it again");
    }

    const claimed = await this.prisma.coolifyCleanup.updateMany({ where: { id, status: "READY" }, data: { status: "CLEANING", confirmedById: userId, confirmedAt: new Date() } });
    if (claimed.count !== 1) throw conflict("not_ready", "this cleanup is not ready to confirm");
    await this.audit.log({ actor: userId, action: "coolify.cleanup.confirm", target: row.serverId, meta: { cleanupId: id, removable: removable(scan.remnants).length } });

    const job = this.execute(id, userId, row.serverId, knownUuids, completeUuids, removable(scan.remnants)).catch((e: unknown) => this.log.error(`cleanup run failed: ${e instanceof Error ? e.constructor.name : "unknown"}`));
    this.running.set(id, job);
    void job.finally(() => this.running.delete(id));
    return this.toView(await this.loadRow(id));
  }

  /** Test hook: resolves when a removal started here has ended. */
  async settled(id: string): Promise<void> {
    await this.running.get(id);
  }

  private async execute(id: string, userId: string, serverId: string, knownUuids: string[], completeUuids: string[], items: CleanupRemnant[]): Promise<void> {
    let results: CleanupResult[] = [];
    let after: CleanupRemnant[] | null = null;
    let failureCode: string | null = null;
    try {
      const out = await this.withCapability(serverId, async () => {
        const removal = items.length ? await this.agentWs.sendCommand(serverId, buildRemoveScript(items), CAPABILITY, REMOVE_TIMEOUT_MS) : { exitCode: 0, output: "TUGRA_CU_DONE" };
        const verify = await this.agentWs.sendCommand(serverId, buildScanScript(), CAPABILITY, SCAN_TIMEOUT_MS);
        return { removal, verify };
      });
      results = items.length ? parseRemoveOutput(out.removal.output, items) : [];
      after = classifyScan(parseScan(out.verify.output), { knownUuids, completeUuids }).remnants;
      for (const r of results) await this.audit.log({ actor: userId, action: "coolify.cleanup.remove", target: serverId, meta: { cleanupId: id, kind: r.kind, name: r.name, code: r.code } });
      const confirmed = new Set(items.map((i) => `${i.kind}:${i.name}`));
      const left = removable(after);
      if (results.some((r) => r.code !== "ok" && r.code !== "absent") || left.some((r) => confirmed.has(`${r.kind}:${r.name}`))) failureCode = "partial";
      // Something that was held back by a container this run removed (its directory) is now free, but the owner never confirmed it:
      // it waits for the next look.
      else if (left.length > 0) failureCode = "recheck";
    } catch (e) {
      failureCode = e instanceof ScanError ? "scan_unreadable" : "agent_error";
      this.log.warn(`cleanup removal failed: ${e instanceof Error ? e.constructor.name : "unknown"}`);
    }
    const done = failureCode === null;
    await this.prisma.coolifyCleanup.update({
      where: { id },
      data: {
        status: done ? "CLEANED" : "FAILED",
        results: results as unknown as Prisma.InputJsonValue,
        ...(after ? { remnants: after as unknown as Prisma.InputJsonValue } : {}),
        failureCode,
        cleanedAt: done ? new Date() : null,
      },
    });
    // Coolify's leftovers are gone: "give back to Coolify" cannot work any more (the hub refuses it, not only the button). Only the takeover
    // that finished is closed here: one that started on the server while this ran is not touched.
    if (done) await this.prisma.coolifyTakeover.updateMany({ where: { serverId, giveBackAvailable: true, status: "VERIFIED" }, data: { giveBackAvailable: false } });
    await this.audit.log({ actor: userId, action: "coolify.cleanup.done", target: serverId, meta: { cleanupId: id, ok: done, code: failureCode } });
  }

  // ───────────────────────────── internals ─────────────────────────────

  /**
   * Nothing may be removed from Coolify while something can still need it: a guided run that holds the server (it may still undo or give
   * back), or a takeover that is not finished (only a VERIFIED one, or one that was given back and holds nothing, lets Coolify's leftovers go).
   */
  private async assertServerFree(serverId: string): Promise<void> {
    if ((await this.prisma.migrationRunServerLock.count({ where: { serverId } })) > 0) throw conflict("server_busy", "a guided run still holds this server: finish or abort it first");
    const takeover = await this.prisma.coolifyTakeover.findFirst({ where: { serverId }, orderBy: { createdAt: "desc" }, select: { status: true } });
    if (takeover && takeover.status !== "VERIFIED" && takeover.status !== "GIVEN_BACK") throw conflict("takeover_not_verified", "the takeover of this server is not verified yet: finish it first");
  }

  private async assertNoActive(serverId: string): Promise<void> {
    const since = new Date(Date.now() - STALE_MS);
    const active = await this.prisma.coolifyCleanup.findFirst({ where: { serverId, status: { in: ["CHECKING", "CLEANING"] }, updatedAt: { gt: since } }, select: { id: true } });
    if (active) throw conflict("cleanup_active", "a cleanup is already running on this server");
  }

  /** Run `fn` with the cleanup capability granted, and take it away afterwards if (and only if) this call granted it. */
  private async withCapability<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    const granted = await this.servers.setRunCapability(serverId, CAPABILITY, true);
    try {
      return await fn();
    } finally {
      if (granted) await this.servers.setRunCapability(serverId, CAPABILITY, false).catch(() => undefined);
    }
  }

  /** The host's side: the parsed listing (containers, volume names and mounts). Classification needs the checklist first, see {@link judge}. */
  private async scan(serverId: string): Promise<ScanResult> {
    const out = await this.withCapability(serverId, () => this.agentWs.sendCommand(serverId, buildScanScript(), CAPABILITY, SCAN_TIMEOUT_MS));
    return parseScan(out.output);
  }

  /** The stored read that knows this server and its Coolify side. Throws 409 when the server is the Coolify host or no read knows it. */
  private async resolveCoolify(userId: string, server: Server): Promise<ReturnType<typeof coolifySideFor>> {
    // The Coolify hub may sit in another of the owner's teams than this server: any inventory of a team the caller belongs to can know it
    // (the caller is already this server team's owner, so the comparison shows them nothing they could not read in their own teams).
    const inventories = await this.prisma.coolifyInventory.findMany({ where: { teamId: { in: await this.access.teamIds(userId) } } });
    if (inventories.some((inv) => inv.serverId === server.id)) throw conflict("control_plane", "this server is the Coolify host: it is retired separately");
    for (const inv of inventories) {
      if (!isInventory(inv.snapshot)) continue;
      const links = inv.serverLinks && typeof inv.serverLinks === "object" && !Array.isArray(inv.serverLinks) ? (inv.serverLinks as Record<string, { serverId: string }>) : {};
      const cs = coolifyServerFor(inv.snapshot, links, server);
      if (!cs) continue;
      if (cs.isLocal) throw conflict("control_plane", "this server is the Coolify host: it is retired separately");
      // Fail closed on the age of the read: no time, or too old, is refused.
      if (!inv.readAt || Date.now() - new Date(inv.readAt).getTime() > READ_MAX_AGE_MS) throw conflict("read_stale", "the stored Coolify read is too old: read the Coolify again first");
      return coolifySideFor(inv.snapshot, cs.id);
    }
    throw conflict("no_coolify_link", "read the Coolify first: no stored Coolify read knows this server");
  }

  /** The checklist: Coolify's side (volumes and running state from the host where the read has none) against what Tugra holds on this server. */
  private async judge(server: Server, found: ReturnType<typeof coolifySideFor>, raw: ScanResult): Promise<{ rows: CompletenessRow[]; complete: boolean; completeUuids: string[] }> {
    const side = withHostVolumes(found.side, raw.volumes, raw.containers);
    const hosts = side.applications.flatMap((a) => a.domains);
    const cutover = hosts.length ? await checkTraffic(hosts, { ipv4: server.publicIp, ipv6: server.publicIpv6 }, { dns: this.dns, net: this.net }) : {};
    const result = compareCompleteness(side, { ...(await this.tugraSide(server)), cutover });
    const rows = result.rows.map((r) => ((found.unreadable as string[]).includes(r.kind) ? { ...r, unreadable: true } : r));
    const complete = isComplete(rows);
    // A section the read could not carry makes the whole checklist incomplete; no item may then count as verified.
    return { rows, complete, completeUuids: complete ? result.completeUuids : [] };
  }

  private async tugraSide(server: Server): Promise<TugraSide> {
    const [apps, dbs, channels, tasks] = await Promise.all([
      this.prisma.application.findMany({
        where: { teamId: server.teamId, serverId: server.id, isPreview: false },
        select: { id: true, name: true, status: true, envEnc: true, domain: true, extraDomains: true, domainRedirect: true, volumes: true, composeFile: true, domains: { select: { hostname: true } } },
      }),
      this.prisma.database.findMany({ where: { teamId: server.teamId, serverId: server.id }, select: { id: true, name: true, status: true, backupEnabled: true, volumes: true } }),
      this.prisma.notificationChannel.findMany({ where: { teamId: server.teamId, enabled: true }, select: { type: true } }),
      this.prisma.scheduledTask.findMany({ where: { application: { teamId: server.teamId, serverId: server.id } }, select: { appId: true, name: true } }),
    ]);
    const taskNames = new Map<string, string[]>();
    for (const t of tasks) taskNames.set(t.appId, [...(taskNames.get(t.appId) ?? []), t.name]);
    const sourceRefs = await this.sourceRefs([...apps.map((a) => a.id), ...dbs.map((d) => d.id)]);
    const tugraApps: TugraApp[] = apps.map((a) => ({
      id: a.id,
      name: a.name,
      sourceRef: sourceRefs.get(a.id) ?? null,
      envKeys: this.envKeyCount(a.envEnc),
      domains: [a.domain, a.domainRedirect, ...a.extraDomains, ...a.domains.map((d) => d.hostname)].filter((h): h is string => !!h),
      volumes: [...namedVolumes(a.volumes), ...composeVolumes({ id: a.id, composeFile: a.composeFile }).map((v) => v.key)],
      tasks: taskNames.get(a.id) ?? [],
      running: a.status === "RUNNING",
      members: a.composeFile ? composeServiceNames(a.composeFile).length : null,
    }));
    const tugraDbs: TugraDb[] = dbs.map((d) => ({ id: d.id, name: d.name, sourceRef: sourceRefs.get(d.id) ?? null, volumes: ["data", ...namedVolumes(d.volumes)], backupEnabled: d.backupEnabled, running: d.status === "RUNNING" }));
    return { applications: tugraApps, databases: tugraDbs, notificationTypes: channels.map((c) => c.type) };
  }

  /** The Coolify ref each Tugra resource was created from, as the importer recorded it on its task (`kind:<serverRef>:<ref>`). */
  private async sourceRefs(resourceIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!resourceIds.length) return out;
    const tasks = await this.prisma.bulkTask.findMany({ where: { resourceId: { in: resourceIds }, itemRef: { not: null } }, select: { resourceId: true, itemRef: true } });
    for (const t of tasks) {
      const parts = (t.itemRef ?? "").split(":");
      if (t.resourceId && parts.length >= 3 && ["app", "database", "service"].includes(parts[0])) out.set(t.resourceId, parts.slice(2).join(":"));
    }
    return out;
  }

  /** How many variable names the app holds. Names only: the values are decrypted to be counted and dropped at once. */
  private envKeyCount(envEnc: string | null): number {
    if (!envEnc) return 0;
    try {
      const v: unknown = JSON.parse(this.crypto.decrypt(envEnc));
      return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).length : 0;
    } catch {
      return 0;
    }
  }

  private async finish(id: string, status: CleanupStatus, patch: { completeness?: CompletenessRow[]; remnants?: CleanupRemnant[]; failureCode?: string }): Promise<CleanupView> {
    const row = await this.prisma.coolifyCleanup.update({
      where: { id },
      data: {
        status,
        ...(patch.completeness ? { completeness: patch.completeness as unknown as Prisma.InputJsonValue } : {}),
        ...(patch.remnants ? { remnants: patch.remnants as unknown as Prisma.InputJsonValue } : {}),
        ...(patch.failureCode ? { failureCode: patch.failureCode } : {}),
      },
    });
    return this.toView(row);
  }

  private async loadRow(id: string): Promise<CoolifyCleanup> {
    const row = await this.prisma.coolifyCleanup.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("cleanup not found");
    return row;
  }

  toView(row: CoolifyCleanup): CleanupView {
    const completeness = (Array.isArray(row.completeness) ? row.completeness : []) as unknown as CompletenessRow[];
    const remnants = remnantsOf(row);
    return {
      id: row.id,
      serverId: row.serverId,
      status: row.status as CleanupStatus,
      completeness,
      remnants,
      listHash: row.status === "READY" || row.status === "INCOMPLETE" ? listHash(remnants) : null,
      results: (Array.isArray(row.results) ? row.results : []) as unknown as CleanupResult[],
      complete: isComplete(completeness),
      failureCode: row.failureCode,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      cleanedAt: row.cleanedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function namedVolumes(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? (x as { name?: unknown }).name : null)).filter((n): n is string => typeof n === "string") : [];
}
