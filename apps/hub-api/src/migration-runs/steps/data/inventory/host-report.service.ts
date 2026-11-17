import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional, PayloadTooLargeException, UnsupportedMediaTypeException } from "@nestjs/common";
import type { Readable } from "node:stream";
import { PrismaService } from "../../../../prisma/prisma.service";
import { TeamAccessService } from "../../../../common/team-access.service";
import type { MigrationTokenContext } from "../../../../importer/migration-token.service";
import { vxPartRawBytes } from "../../../../importer/volume-stream/vx-constants";
import { isTerminalRunStatus, type RunStatus } from "../../../core/run-contract";
import { HOST_REPORT_PORT, type HostReportPort } from "./inventory-contract";
import { REF_RE, REPORT_MAX_BYTES, parseReportBody, type HostInventory } from "./host-protocol";
import { PROBE_MAX_BYTES } from "./inventory-script";
import { mergeFreeze } from "./report-merge";
import { serverRefOfItem } from "./host-hosts";
import { RUN_HINTS, type RunHintStore } from "../../import/baseline/run-hints";
import { validContainerPrefix } from "../../../../importer/container-prefix";
import { derivePins, pinsToWrite, type PinCandidate } from "./inventory-pins";

type RawReq = Readable & { headers: Record<string, string | string[] | undefined> };

/** Read a bounded text body from the raw request stream (the report is `text/plain`, never parsed by a body parser). */
export async function readTextBody(req: RawReq, cap: number): Promise<string> {
  const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!ctype.startsWith("text/plain")) throw new UnsupportedMediaTypeException("text/plain expected");
  const len = Number(req.headers["content-length"]);
  if (Number.isFinite(len) && len > cap) throw new PayloadTooLargeException("report too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > cap) throw new PayloadTooLargeException("report too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Count (and discard) a raw upload up to `cap` bytes: the hub-side end of the reach probe. Never buffers the body. */
export async function countBody(req: RawReq, cap: number): Promise<number> {
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > cap) throw new PayloadTooLargeException("probe too large");
  }
  return size;
}

/**
 * Receives what the source-host scripts report: per-host loop status, the host inventory, the hub reach probe and the freeze
 * outcome. The run comes from the TOKEN's op alone; a host label that is not one of the run's own hosts is dropped (a spoofed
 * label can never create a report row); the body is validated strictly by `parseReportBody`. A migration run that is not a guided
 * run has nowhere to store the lines and is answered `stored: 0`, never an error.
 */
@Injectable()
export class HostReportService {
  private readonly logger = new Logger(HostReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    @Inject(HOST_REPORT_PORT) private readonly reports: HostReportPort,
    @Optional() @Inject(RUN_HINTS) private readonly hints?: RunHintStore,
  ) {}

  /** The hub's part size, which the source-side probe tries first. */
  ping(): { ok: true; partMiB: number } {
    return { ok: true, partMiB: Math.round(vxPartRawBytes() / (1024 * 1024)) };
  }

  /** The body cap of the probe sink (more than any part size). */
  readonly probeCap = PROBE_MAX_BYTES;

  async ingest(op: MigrationTokenContext, text: string): Promise<{ stored: number; ignored: number }> {
    if (Buffer.byteLength(text) > REPORT_MAX_BYTES) throw new PayloadTooLargeException("report too large");
    const parsed = parseReportBody(text);
    if (parsed.lines === 0) throw new BadRequestException("empty report");
    const run = await this.prisma.migrationRun.findUnique({ where: { opId: op.opId }, select: { id: true, actorId: true, status: true, targetServerId: true, serverMap: true, promotedFromId: true } });
    if (!run || isTerminalRunStatus(run.status as RunStatus)) return { stored: 0, ignored: parsed.lines };
    if (run.actorId !== op.actorId) throw new ConflictException("not your operation");
    const server = await this.prisma.server.findUnique({ where: { id: run.targetServerId }, select: { teamId: true } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(op.actorId, server.teamId, "apps:config");

    // the hosts of THIS run: its serverMap keys and the server refs its plan items carry (never the source's own claim)
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId: op.opId }, select: { itemRef: true } });
    const valid = new Set<string>(["_", ...Object.keys((run.serverMap as Record<string, string> | null) ?? {})]);
    for (const t of tasks) if (t.itemRef && /^(app|service|database|volume):/.test(t.itemRef)) valid.add(serverRefOfItem(t.itemRef));
    const known = (ref: string): boolean => REF_RE.test(ref) && valid.has(ref);

    let stored = 0;
    let ignored = parsed.rejected;
    for (const l of parsed.loop) {
      if (!known(l.ref)) {
        ignored++;
        continue;
      }
      await this.reports.put({ runId: run.id, stepKey: l.step, sourceServerRef: l.ref, kind: "loop", state: l.state, payload: { code: l.code, rc: l.rc } });
      stored++;
    }
    for (const [ref, inv] of parsed.inventory) {
      if (!known(ref)) {
        ignored++;
        continue;
      }
      if (!inv.complete) {
        // a partial upload must not replace a whole earlier snapshot; it is stored only when there is none
        const prev = (await this.reports.list(run.id, "inventory")).find((r) => r.sourceServerRef === ref);
        if (prev && prev.state === "complete") {
          ignored++;
          continue;
        }
      }
      await this.reports.put({ runId: run.id, stepKey: "", sourceServerRef: ref, kind: "inventory", state: inv.complete ? "complete" : "partial", payload: inv as unknown as Record<string, unknown> });
      stored++;
    }
    for (const r of parsed.reach) {
      if (!known(r.ref)) {
        ignored++;
        continue;
      }
      await this.reports.put({ runId: run.id, stepKey: "", sourceServerRef: r.ref, kind: "reach", state: r.pingCode === 200 ? "ok" : "failed", payload: r as unknown as Record<string, unknown> });
      stored++;
    }
    for (const [ref, part] of parsed.freeze) {
      if (!known(ref)) {
        ignored++;
        continue;
      }
      const prev = (await this.reports.list(run.id, "freeze")).find((r) => r.sourceServerRef === ref);
      const merged = mergeFreeze(prev?.payload ?? null, part);
      await this.reports.put({ runId: run.id, stepKey: "FREEZE", sourceServerRef: ref, kind: "freeze", state: merged.state, payload: merged.payload as unknown as Record<string, unknown> });
      stored++;
    }
    if (ignored) this.logger.warn(`run ${run.id}: ${ignored} host report line(s) ignored (unknown host label or invalid line)`);
    if (parsed.inventory.size) await this.autoPins(op.opId, run.id, run.promotedFromId ?? null, parsed.inventory);
    return { stored, ignored };
  }

  /**
   * R11: record, as hints of the run, the digest the host reports for every floating-tag image app of the plan. Best effort: a
   * failure here never fails the report (the operator can still set a pin by hand). An operator's own pin is never replaced.
   */
  private async autoPins(opId: string, runId: string, promotedFromId: string | null, inventories: ReadonlyMap<string, HostInventory>): Promise<void> {
    if (!this.hints) return;
    try {
      const row = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { meta: true } });
      const meta = typeof row?.meta === "object" && row.meta ? (row.meta as { plan?: { items?: Array<{ itemRef?: unknown; kind?: unknown; proposed?: { source?: unknown; image?: unknown; containerPrefix?: unknown } }> } }) : {};
      const candidates: PinCandidate[] = (meta.plan?.items ?? []).flatMap((i) =>
        i.kind === "app" && typeof i.itemRef === "string" && i.proposed?.source === "IMAGE" && typeof i.proposed.image === "string" ? [{ itemRef: i.itemRef, image: i.proposed.image, ...(validContainerPrefix(i.proposed.containerPrefix) ? { containerPrefix: i.proposed.containerPrefix } : {}) }] : [],
      );
      if (!candidates.length) return;
      const write = pinsToWrite(derivePins(candidates, inventories), await this.hints.list(runId, promotedFromId));
      if (write.length) await this.hints.upsert(runId, write);
    } catch (e) {
      this.logger.warn(`run ${runId}: could not record image pins from the inventory: ${e instanceof Error ? e.constructor.name : "error"}`);
    }
  }
}
