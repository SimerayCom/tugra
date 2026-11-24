import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { TeamAccessService } from "../../common/team-access.service";
import { AgentWsServer } from "../../agent-gateway/agent-ws.server";
import { NotificationsService } from "../../notifications/notifications.service";
import { MonitorsService } from "../monitors.service";
import { CreateMonitorSchema } from "../dto";
import type { KumaApplyInput, KumaDetectInput, KumaPreviewInput, KumaSource } from "./dto";
import { KumaParseError, parseKumaBackup, type KumaDump } from "./kuma-model";
import {
  buildDetectScript,
  buildDumpScript,
  DEFAULT_SQLITE_IMAGE,
  assertSafeImage,
  KumaDumpError,
  parseDetect,
  parseDump,
  type DetectedKuma,
} from "./kuma-sqlite";
import { buildPlan, type ImportPlan, type InternalPlan } from "./kuma-plan";

const DETECT_TIMEOUT_MS = 30_000;
// The first run may have to pull the SQLite image; generous, but bounded.
const DUMP_TIMEOUT_MS = 180_000;
const MAX_DUMP_BYTES = 16 * 1024 * 1024;

export interface ApplyItemResult {
  ref: string;
  name: string;
  status: "created" | "reused" | "exists" | "skipped" | "failed";
  id?: string;
  /** Developer-facing detail for a failure (shown behind "More"). */
  error?: string;
}

export interface ApplyResult {
  channels: ApplyItemResult[];
  monitors: ApplyItemResult[];
  totals: { monitorsCreated: number; monitorsFailed: number; channelsCreated: number; channelsFailed: number };
}

/**
 * "Import from Uptime Kuma": a dry-run preview and an apply step over the same plan. The plan is rebuilt from the
 * source on every call (nothing with secrets is cached between preview and apply), so what is applied is exactly
 * what the source holds now. Every write goes through MonitorsService / NotificationsService, so team scoping,
 * permission checks, SSRF validation of channel hosts, encryption and audit entries are the ones those services
 * already enforce.
 */
@Injectable()
export class KumaImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly agentWs: AgentWsServer,
    private readonly monitors: MonitorsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Find Uptime Kuma containers on one of the team's servers. */
  async detect(userId: string, input: KumaDetectInput): Promise<{ containers: DetectedKuma[] }> {
    await this.requireServer(userId, input.teamId, input.serverId);
    const r = await this.agentWs.sendCommand(input.serverId, buildDetectScript(), "deploy", DETECT_TIMEOUT_MS);
    const parsed = parseDetect(r.output);
    if (parsed.noDocker) throw new BadRequestException({ code: "no_docker", message: "Docker is not available on this server" });
    return { containers: parsed.found };
  }

  async preview(userId: string, input: KumaPreviewInput): Promise<ImportPlan> {
    await this.access.requirePermission(userId, input.teamId, "monitors");
    const plan = await this.plan(userId, input.teamId, input.source);
    return plan.view;
  }

  async apply(userId: string, input: KumaApplyInput): Promise<ApplyResult> {
    await this.access.requirePermission(userId, input.teamId, "monitors");
    const createRefs = new Set(input.createChannelRefs ?? []);
    // Creating channels is a separate permission; refuse up front rather than half-way through.
    if (createRefs.size > 0) await this.access.requirePermission(userId, input.teamId, "integrations");

    const plan = await this.plan(userId, input.teamId, input.source);
    const selected = input.monitorRefs ? new Set(input.monitorRefs) : null;

    // 1. Channels the user confirmed. Channels that already exist in the team are reused without asking.
    const channelIds = new Map<string, string>();
    const channelResults: ApplyItemResult[] = [];
    for (const c of plan.view.channels) {
      if (c.action === "reuse" && c.existingId) {
        channelIds.set(c.ref, c.existingId);
        channelResults.push({ ref: c.ref, name: c.name, status: "reused", id: c.existingId });
        continue;
      }
      if (c.action !== "create") continue;
      const mapped = plan.channels.get(c.ref);
      if (!mapped || !createRefs.has(c.ref)) {
        channelResults.push({ ref: c.ref, name: c.name, status: "skipped" });
        continue;
      }
      try {
        const created = await this.notifications.create(userId, {
          name: mapped.name,
          type: mapped.type,
          teamId: input.teamId,
          config: mapped.config,
          eventTypes: [],
        });
        channelIds.set(c.ref, created.id);
        channelResults.push({ ref: c.ref, name: c.name, status: "created", id: created.id });
      } catch (e) {
        channelResults.push({ ref: c.ref, name: c.name, status: "failed", error: errorText(e) });
      }
    }

    // 2. Monitors.
    const monitorResults: ApplyItemResult[] = [];
    for (const m of plan.view.monitors) {
      if (m.action === "exists") {
        monitorResults.push({ ref: m.ref, name: m.name, status: "exists" });
        continue;
      }
      if (m.action !== "create") continue;
      const entry = plan.drafts.get(m.ref);
      if (!entry || (selected && !selected.has(m.ref))) {
        monitorResults.push({ ref: m.ref, name: m.name, status: "skipped" });
        continue;
      }
      const linked = [...new Set(entry.channelRefs.map((r) => channelIds.get(r)).filter((id): id is string => !!id))];
      const body = CreateMonitorSchema.safeParse({ ...entry.draft, teamId: input.teamId, channelIds: linked });
      if (!body.success) {
        monitorResults.push({ ref: m.ref, name: m.name, status: "failed", error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        continue;
      }
      try {
        const created = await this.monitors.create(userId, body.data);
        monitorResults.push({ ref: m.ref, name: m.name, status: "created", id: created.id });
      } catch (e) {
        monitorResults.push({ ref: m.ref, name: m.name, status: "failed", error: errorText(e) });
      }
    }

    const totals = {
      monitorsCreated: monitorResults.filter((r) => r.status === "created").length,
      monitorsFailed: monitorResults.filter((r) => r.status === "failed").length,
      channelsCreated: channelResults.filter((r) => r.status === "created").length,
      channelsFailed: channelResults.filter((r) => r.status === "failed").length,
    };
    await this.audit.log({
      actor: userId,
      action: "monitor.import.kuma",
      target: input.teamId,
      meta: { source: input.source.kind, ...totals },
    });
    return { channels: channelResults, monitors: monitorResults, totals };
  }

  private async plan(userId: string, teamId: string, source: KumaSource): Promise<InternalPlan> {
    const dump = await this.load(userId, teamId, source);
    const [existingMonitors, existingChannels] = await Promise.all([
      this.prisma.monitor.findMany({ where: { teamId }, select: { name: true, type: true, target: true } }),
      this.prisma.notificationChannel.findMany({ where: { teamId }, select: { id: true, name: true, type: true } }),
    ]);
    return buildPlan(dump, existingMonitors, existingChannels);
  }

  private async load(userId: string, teamId: string, source: KumaSource): Promise<KumaDump> {
    if (source.kind === "backup") {
      try {
        return parseKumaBackup(source.json);
      } catch (e) {
        if (e instanceof KumaParseError) throw new BadRequestException({ code: e.code, message: `This is not a usable Uptime Kuma backup (${e.code})` });
        throw e;
      }
    }
    await this.requireServer(userId, teamId, source.serverId);
    const container = source.container ?? (await this.onlyKuma(source.serverId));
    const image = assertSafeImage(this.config.get<string>("KUMA_IMPORT_SQLITE_IMAGE") || DEFAULT_SQLITE_IMAGE);
    // Chunks are collected live: the final result text is capped by the agent, a large monitor table is not.
    let streamed = "";
    let over = false;
    const r = await this.agentWs.sendCommand(
      source.serverId,
      buildDumpScript(container, image),
      "deploy",
      DUMP_TIMEOUT_MS,
      (chunk) => {
        if (streamed.length + chunk.length > MAX_DUMP_BYTES) over = true;
        else streamed += chunk;
      },
    );
    if (over) throw new BadRequestException({ code: "too_large", message: "The Uptime Kuma data is too large to import" });
    try {
      return parseDump(streamed.length >= r.output.length ? streamed : r.output);
    } catch (e) {
      if (e instanceof KumaDumpError) throw new BadRequestException({ code: e.failure, message: `Could not read Uptime Kuma data (${e.failure})` });
      if (e instanceof KumaParseError) throw new BadRequestException({ code: e.code, message: `Could not read Uptime Kuma data (${e.code})` });
      throw e;
    }
  }

  /** With no container named, accept the only Kuma on the host; otherwise the caller must pick (see detect). */
  private async onlyKuma(serverId: string): Promise<string> {
    const r = await this.agentWs.sendCommand(serverId, buildDetectScript(), "deploy", DETECT_TIMEOUT_MS);
    const parsed = parseDetect(r.output);
    if (parsed.noDocker) throw new BadRequestException({ code: "no_docker", message: "Docker is not available on this server" });
    const usable = parsed.found.filter((c) => c.hasData);
    if (usable.length === 0) throw new NotFoundException({ code: "not_found", message: "No Uptime Kuma container found on this server" });
    if (usable.length > 1) throw new BadRequestException({ code: "pick_container", message: "More than one Uptime Kuma container found; choose one" });
    return usable[0].container;
  }

  /** The server must belong to the team the import targets, and the caller needs ops rights on it (the script
   *  runs docker on the host with the Kuma data mounted, so it is held to the same bar as other server ops). */
  private async requireServer(userId: string, teamId: string, serverId: string): Promise<void> {
    await this.access.requirePermission(userId, teamId, "servers:ops");
    const server = await this.prisma.server.findFirst({ where: { id: serverId, teamId }, select: { id: true } });
    if (!server) throw new NotFoundException("server not found");
  }
}

function errorText(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; getResponse?: () => unknown };
    const res = typeof o.getResponse === "function" ? o.getResponse() : null;
    if (res && typeof res === "object" && "message" in res) return String((res as { message: unknown }).message).slice(0, 300);
    if (typeof o.message === "string") return o.message.slice(0, 300);
  }
  return "failed";
}
