import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, Role, ServerStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ServersService } from "../servers/servers.service";
import { buildDetectScript, buildReadScript, CFY } from "./coolify-read-script";
import {
  buildInventory,
  CoolifyReadError,
  parseRead,
  type CoolifyInventoryData,
  type InventoryCounts,
  type InvServer,
} from "./coolify-inventory";
import { defaultTeamFor, sshHint, uniqueNames, type ChecklistRow, type ServerLink } from "./coolify-install-plan";
import { HostMatchService, linkOf } from "./host-match.service";
import type { CoolifyHostInput } from "./host-match";
import type { GenerateInput } from "./dto";

const DETECT_TIMEOUT_MS = 30_000;
// ~30 small read-only queries; generous but bounded.
const READ_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
/** A second read within this window returns the stored snapshot: it keeps a click-happy page from hammering the host. */
export const READ_MIN_INTERVAL_MS = 10_000;

const ADMIN_ROLES: Role[] = [Role.OWNER, Role.ADMIN];

export interface InventorySummary {
  serverId: string;
  serverName: string;
  enabledAt: string;
  readAt: string | null;
  coolifyImage: string | null;
  counts: InventoryCounts | null;
}

export interface InventoryView extends InventorySummary {
  teamId: string;
  data: CoolifyInventoryData | null;
}

export interface ChecklistView {
  rows: ChecklistRow[];
  /** Tugra teams the caller can add servers to (for the team mapping). */
  teams: Array<{ id: string; name: string }>;
}

function errorClass(e: unknown): string {
  return e instanceof Error ? e.constructor.name : "unknown";
}

function isInventory(v: unknown): v is CoolifyInventoryData {
  return !!v && typeof v === "object" && (v as { v?: unknown }).v === 1 && Array.isArray((v as { servers?: unknown }).servers);
}

function parseLinks(v: unknown): Record<string, ServerLink> {
  const out: Record<string, ServerLink> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, l] of Object.entries(v as Record<string, unknown>)) {
    const o = l as { teamId?: unknown; serverId?: unknown; linkedBy?: unknown; evidence?: unknown } | null;
    if (o && typeof o.teamId === "string" && typeof o.serverId === "string") {
      // `linkedBy` and `evidence` are additive: a link written before them reads as a link the user made.
      out[k] = { teamId: o.teamId, serverId: o.serverId, linkedBy: o.linkedBy === "auto" ? "auto" : "user", ...(Array.isArray(o.evidence) ? { evidence: o.evidence as ServerLink["evidence"] } : {}) };
    }
  }
  return out;
}

/**
 * "Read this Coolify" (no Coolify API needed): an owner/admin opts ONE agent server in, then the hub has the agent read that
 * host's Coolify database read-only and stores a metadata-only inventory. Secrets are never read (see coolify-sql.ts). Every
 * step is audited. Nothing here moves or changes anything: the actual move stays the API-based import, and the install
 * commands for the other Coolify servers are only shown, never run.
 */
@Injectable()
export class CoolifyTakeoverService {
  /** Single-flight per server: the read is a few seconds of work on the host. */
  private readonly inflight = new Map<string, Promise<InventoryView>>();
  private readonly generating = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly servers: ServersService,
    private readonly hostMatch: HostMatchService,
  ) {}

  // ---- reads (stored data only) ----------------------------------------------------------------------------------------

  async list(userId: string, teamId: string): Promise<InventorySummary[]> {
    await this.access.requireRole(userId, teamId, ADMIN_ROLES);
    const rows = await this.prisma.coolifyInventory.findMany({
      where: { teamId },
      orderBy: { createdAt: "asc" },
      include: { server: { select: { name: true } } },
    });
    return rows.map((r) => this.summary(r, r.server.name));
  }

  async get(userId: string, serverId: string): Promise<InventoryView> {
    const row = await this.requireOptIn(userId, serverId);
    return this.view(row, row.server.name);
  }

  // ---- agent calls ------------------------------------------------------------------------------------------------------

  /**
   * Is there a running Coolify database on this server? Reads nothing from it (only `docker inspect` of two containers), so
   * it is deliberately allowed BEFORE the opt-in: it is the "Check for Coolify" step that precedes the opt-in. Owner/admin only
   * and audited whether or not the agent answers.
   */
  async detect(userId: string, serverId: string): Promise<{ found: boolean; image: string | null; reason?: "no_docker" | "db_stopped" }> {
    const server = await this.requireServer(userId, serverId);
    let r: { output: string };
    try {
      r = await this.agentWs.sendCommand(server.id, buildDetectScript(), "database", DETECT_TIMEOUT_MS);
    } catch (e) {
      await this.audit.log({ actor: userId, action: "coolify.takeover.detect", target: server.id, meta: { failure: errorClass(e) } });
      throw e;
    }
    await this.audit.log({ actor: userId, action: "coolify.takeover.detect", target: server.id });
    if (r.output.includes(CFY.noDocker)) return { found: false, image: null, reason: "no_docker" };
    if (r.output.includes(CFY.stopped)) return { found: false, image: null, reason: "db_stopped" };
    if (r.output.includes(CFY.noCoolify)) return { found: false, image: null };
    const m = /^TUGRA_CFY_IMAGE (.*)$/m.exec(r.output);
    return { found: true, image: m ? m[1].trim().slice(0, 200) || null : null };
  }

  /** The explicit per-server opt-in. Idempotent. */
  async enable(userId: string, serverId: string): Promise<InventoryView> {
    const server = await this.requireServer(userId, serverId);
    const row = await this.prisma.coolifyInventory.upsert({
      where: { serverId: server.id },
      create: { teamId: server.teamId, serverId: server.id, enabledById: userId },
      update: {},
      include: { server: { select: { name: true } } },
    });
    await this.audit.log({ actor: userId, action: "coolify.takeover.enable", target: server.id });
    return this.view(row, row.server.name);
  }

  /** Withdraw the opt-in and delete what was read. */
  async disable(userId: string, serverId: string): Promise<{ ok: true }> {
    const server = await this.requireServer(userId, serverId);
    await this.prisma.coolifyInventory.deleteMany({ where: { serverId: server.id } });
    await this.audit.log({ actor: userId, action: "coolify.takeover.disable", target: server.id });
    return { ok: true };
  }

  /** Read the Coolify database now (opted-in servers only) and store the inventory. */
  async read(userId: string, serverId: string): Promise<InventoryView> {
    const row = await this.requireOptIn(userId, serverId);
    if (row.readAt && Date.now() - row.readAt.getTime() < READ_MIN_INTERVAL_MS && isInventory(row.snapshot)) {
      return this.view(row, row.server.name);
    }
    const running = this.inflight.get(serverId);
    if (running) return running;
    const p = this.runRead(userId, row.id, serverId, row.server.name);
    this.inflight.set(serverId, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(serverId);
    }
  }

  private async runRead(userId: string, inventoryId: string, serverId: string, serverName: string): Promise<InventoryView> {
    // Chunks are collected live: the final result text is capped by the agent, a big environment-variable table is not.
    let streamed = "";
    let over = false;
    try {
      const r = await this.agentWs.sendCommand(serverId, buildReadScript(), "database", READ_TIMEOUT_MS, (chunk) => {
        if (streamed.length + chunk.length > MAX_OUTPUT_BYTES) over = true;
        else streamed += chunk;
      });
      if (over) throw new CoolifyReadError("unreadable");
      const { data, counts } = buildInventory(parseRead(streamed.length >= r.output.length ? streamed : r.output));
      // updateMany: the opt-in may have been withdrawn while the read ran; nothing must be stored then.
      const done = await this.prisma.coolifyInventory.updateMany({
        where: { id: inventoryId },
        data: {
          snapshot: data as unknown as Prisma.InputJsonValue,
          counts: counts as unknown as Prisma.InputJsonValue,
          coolifyImage: data.instance.image,
          readAt: new Date(),
          readById: userId,
        },
      });
      if (done.count === 0) throw new ConflictException({ code: "not_enabled", message: "The opt-in was withdrawn during the read" });
      const saved = await this.prisma.coolifyInventory.findUniqueOrThrow({ where: { id: inventoryId }, include: { server: { select: { name: true } } } });
      await this.audit.log({
        actor: userId,
        action: "coolify.takeover.read",
        target: serverId,
        meta: { ...counts, unavailable: data.unavailable.length },
      });
      return this.view(saved, serverName);
    } catch (e) {
      // Every attempt is audited, including the ones that never got an answer (offline agent, capability, timeout).
      await this.audit.log({ actor: userId, action: "coolify.takeover.read_failed", target: serverId, meta: { failure: e instanceof CoolifyReadError ? e.failure : errorClass(e) } });
      if (e instanceof CoolifyReadError) {
        throw new BadRequestException({ code: e.failure, message: `Could not read Coolify (${e.failure})` });
      }
      throw e;
    }
  }

  // ---- "Add all Coolify servers": a checklist, nothing runs --------------------------------------------------------------

  async checklist(userId: string, serverId: string, publicUrl?: string): Promise<ChecklistView> {
    const row = await this.requireOptIn(userId, serverId);
    return this.buildChecklist(userId, row.teamId, row.serverId, row.snapshot, row.serverLinks, publicUrl);
  }

  /**
   * Create the (PENDING) Tugra servers for the chosen Coolify servers and return the checklist with each install command.
   * A Coolify server that already matches a connected Tugra server by address is linked instead of created again.
   * Re-running is safe: servers that already have a link are left alone.
   */
  async generate(userId: string, serverId: string, input: GenerateInput, publicUrl?: string): Promise<ChecklistView> {
    // Serialized per server (this hub process): a double click or a second admin waits, then sees the links the first call wrote.
    const prev = this.generating.get(serverId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.doGenerate(userId, serverId, input, publicUrl));
    this.generating.set(serverId, run);
    try {
      return await run;
    } finally {
      if (this.generating.get(serverId) === run) this.generating.delete(serverId);
    }
  }

  private async doGenerate(userId: string, serverId: string, input: GenerateInput, publicUrl?: string): Promise<ChecklistView> {
    const row = await this.requireOptIn(userId, serverId);
    if (!isInventory(row.snapshot)) throw new ConflictException({ code: "not_read", message: "Read this Coolify first" });
    const data = row.snapshot;
    const links = parseLinks(row.serverLinks);
    const byId = new Map(data.servers.map((s) => [s.id, s]));

    const wanted = new Map<string, string>(); // coolify server id -> team id (last write wins)
    for (const a of input.assignments) {
      const cs = byId.get(a.coolifyServerId);
      if (!cs) throw new BadRequestException({ code: "unknown_server", message: "That server is not in this inventory" });
      if (cs.isLocal || links[cs.id]) continue;
      wanted.set(cs.id, a.teamId);
    }

    // Servers the user already has in Tugra (any of their teams): match them by the evidence ladder instead of creating a duplicate.
    // Only a certain or probable verdict is adopted, and it is stored with how it was linked and why.
    const verdicts = new Map((await this.hostMatch.verdicts(userId, [...wanted.keys()].map((id) => this.hostInput(byId.get(id)!)), { localServerId: serverId })).map((v) => [v.coolifyServerUuid, v] as const));
    let adopted = 0;
    let ambiguous = 0;
    const toCreate = new Map<string, InvServer[]>();
    for (const [csId, teamId] of wanted) {
      const cs = byId.get(csId)!;
      const verdict = verdicts.get(csId);
      const link = verdict ? linkOf(verdict) : null;
      if (link) {
        links[csId] = link;
        adopted++;
        continue;
      }
      if (verdict?.status === "ambiguous") {
        // Several Tugra servers sit at this address: neither pick one nor add yet another. The row says so.
        ambiguous++;
        continue;
      }
      toCreate.set(teamId, [...(toCreate.get(teamId) ?? []), cs]);
    }

    let created = 0;
    for (const [teamId, list] of toCreate) {
      // servers:manage on the target team is checked by createServersBulk (nothing is written before it passes).
      const res = await this.servers.createServersBulk(userId, uniqueNames(list.map((s) => s.name)), teamId, publicUrl);
      res.servers.forEach((made, i) => {
        links[list[i].id] = { teamId, serverId: made.server.id, linkedBy: "user" };
        created++;
      });
      // Persist after every team so a later failure never orphans the servers that were created.
      await this.prisma.coolifyInventory.update({ where: { id: row.id }, data: { serverLinks: links as unknown as Prisma.InputJsonValue } });
    }
    await this.prisma.coolifyInventory.update({ where: { id: row.id }, data: { serverLinks: links as unknown as Prisma.InputJsonValue } });
    await this.audit.log({ actor: userId, action: "coolify.takeover.servers_generate", target: serverId, meta: { created, adopted, ...(ambiguous ? { ambiguous } : {}) } });
    return this.buildChecklist(userId, row.teamId, row.serverId, row.snapshot, links, publicUrl);
  }

  private async buildChecklist(
    userId: string,
    inventoryTeamId: string,
    agentServerId: string,
    snapshot: unknown,
    linkJson: unknown,
    publicUrl?: string,
  ): Promise<ChecklistView> {
    if (!isInventory(snapshot)) return { rows: [], teams: [] };
    const data = snapshot;
    const links = parseLinks(linkJson);

    const roles = await this.access.roleByTeam(userId);
    const adminTeamIds = [...roles].filter(([, r]) => ADMIN_ROLES.includes(r)).map(([id]) => id);
    const tugraTeams = await this.prisma.team.findMany({ where: { id: { in: adminTeamIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } });

    const known = await this.prisma.server.findMany({
      where: { teamId: { in: [...roles.keys()] } },
      select: { id: true, teamId: true, status: true, publicIp: true, publicIpv6: true, hostname: true, reportedIps: true },
    });
    const byId = new Map(known.map((k) => [k.id, k]));
    // The ladder's verdict for every Coolify server that has no stored link yet (a stored link always wins).
    // A link the hub made itself (an address guess) is read again too: its verdict says whether the machine is still only "probably" the same.
    const unlinked = data.servers.filter((cs) => !cs.isLocal && (!links[cs.id] || links[cs.id].linkedBy === "auto"));
    const verdicts = new Map((await this.hostMatch.verdicts(userId, unlinked.map((cs) => this.hostInput(cs)), { localServerId: agentServerId })).map((v) => [v.coolifyServerUuid, v] as const));

    const rows: ChecklistRow[] = [];
    for (const cs of data.servers) {
      const base = { coolifyServerId: cs.id, coolifyServerUuid: cs.uuid, name: cs.name, ip: cs.ip, port: cs.port, user: cs.user, ssh: sshHint(cs), installCommand: null, expiresAt: null };
      if (cs.isLocal) {
        rows.push({ ...base, state: "this_server", teamId: inventoryTeamId, tugraServerId: agentServerId });
        continue;
      }
      const link = links[cs.id];
      const linked = link ? byId.get(link.serverId) : undefined;
      if (linked && linked.status === ServerStatus.PENDING) {
        let installCommand: string | null = null;
        let expiresAt: string | null = null;
        let noAccess = false;
        try {
          const inst = await this.servers.getInstall(userId, linked.id, publicUrl);
          installCommand = inst.installCommand;
          expiresAt = inst.expiresAt ? inst.expiresAt.toISOString() : null;
        } catch (e) {
          if (!(e instanceof ForbiddenException)) throw e; // a server in a team the caller cannot manage shows no command
          noAccess = true;
        }
        rows.push({ ...base, state: noAccess ? "no_access" : installCommand ? "waiting" : "expired", teamId: linked.teamId, tugraServerId: linked.id, installCommand, expiresAt });
        continue;
      }
      const verdict = verdicts.get(cs.id);
      const adopted = linked ?? (verdict ? byId.get(linkOf(verdict)?.serverId ?? "") : undefined);
      if (adopted) {
        // Only an address guess is worth a check: a user's own link and an identity match are settled.
        const probable = link?.linkedBy !== "user" && verdict?.status === "probable";
        rows.push({ ...base, state: "already_added", teamId: adopted.teamId, tugraServerId: adopted.id, ...(probable ? { probable: true } : {}) });
        continue;
      }
      if (verdict?.status === "ambiguous") {
        rows.push({ ...base, state: "ambiguous", teamId: null, tugraServerId: null });
        continue;
      }
      rows.push({
        ...base,
        state: "not_generated",
        teamId: defaultTeamFor(cs.teamId, data.teams, tugraTeams, tugraTeams.some((t) => t.id === inventoryTeamId) ? inventoryTeamId : (tugraTeams[0]?.id ?? inventoryTeamId)),
        tugraServerId: null,
      });
    }
    return { rows, teams: tugraTeams };
  }

  /** The matcher's view of an inventory server: only the address, never a credential. The Coolify host is "this server". */
  private hostInput(cs: Pick<InvServer, "id" | "ip" | "isLocal">): CoolifyHostInput {
    return { uuid: cs.id, address: cs.ip, isLocal: cs.isLocal };
  }

  // ---- guards -----------------------------------------------------------------------------------------------------------

  /** The server must exist, and the caller must be an owner/admin of its team. */
  private async requireServer(userId: string, serverId: string) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true, teamId: true } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requireRole(userId, server.teamId, ADMIN_ROLES);
    return server;
  }

  /** Owner/admin of the server's team AND the server opted in. */
  private async requireOptIn(userId: string, serverId: string) {
    await this.requireServer(userId, serverId);
    const row = await this.prisma.coolifyInventory.findUnique({ where: { serverId }, include: { server: { select: { name: true } } } });
    if (!row) throw new ForbiddenException({ code: "not_enabled", message: "This server has not been opted in" });
    return row;
  }

  private summary(
    r: { serverId: string; enabledAt: Date; readAt: Date | null; coolifyImage: string | null; counts: unknown },
    serverName: string,
  ): InventorySummary {
    return {
      serverId: r.serverId,
      serverName,
      enabledAt: r.enabledAt.toISOString(),
      readAt: r.readAt ? r.readAt.toISOString() : null,
      coolifyImage: r.coolifyImage,
      counts: r.counts && typeof r.counts === "object" ? (r.counts as InventoryCounts) : null,
    };
  }

  private view(
    r: { teamId: string; serverId: string; enabledAt: Date; readAt: Date | null; coolifyImage: string | null; counts: unknown; snapshot: unknown },
    serverName: string,
  ): InventoryView {
    return { ...this.summary(r, serverName), teamId: r.teamId, data: isInventory(r.snapshot) ? r.snapshot : null };
  }
}
