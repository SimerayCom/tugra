import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../../prisma/prisma.service";
import type { RunSnapshot } from "../../../core/run-contract";
import type { RuntimePort, RuntimeSnapshot } from "../data-contract";

/** What the op provisioned and where it stands now: app/database status, the cutover host rows and the tasks that did not end DONE. */
@Injectable()
export class PrismaRuntime implements RuntimePort {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(run: RunSnapshot): Promise<RuntimeSnapshot> {
    if (!run.opId) return { apps: [], databases: [], hosts: [], incomplete: [] };
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId: run.opId, kind: { in: ["app", "database", "service"] } }, select: { itemRef: true, kind: true, status: true, resourceType: true, resourceId: true, result: true } });
    const appIds = tasks.filter((t) => t.status === "DONE" && t.resourceType === "application" && t.resourceId).map((t) => t.resourceId as string);
    const dbIds = tasks.filter((t) => t.status === "DONE" && t.resourceType === "database" && t.resourceId).map((t) => t.resourceId as string);
    const apps = appIds.length ? await this.prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, name: true, status: true } }) : [];
    const dbs = dbIds.length ? await this.prisma.database.findMany({ where: { id: { in: dbIds } }, select: { id: true, name: true, status: true } }) : [];
    const appById = new Map(apps.map((a) => [a.id, a]));
    const dbById = new Map(dbs.map((d) => [d.id, d]));
    const domains = await this.prisma.cutoverDomain.findMany({ where: { opId: run.opId }, select: { hostname: true, state: true, stateful: true, blockReason: true }, orderBy: { hostname: "asc" } });

    const rt: RuntimeSnapshot = { apps: [], databases: [], hosts: domains.map((d) => ({ hostname: d.hostname, state: d.state, stateful: d.stateful, blockReason: d.blockReason })), incomplete: [] };
    for (const t of tasks) {
      if (!t.itemRef) continue;
      if (t.status === "SKIPPED") continue; // skipped on purpose, with the importer's reason code
      if (t.status !== "DONE") {
        rt.incomplete.push({ itemRef: t.itemRef, kind: t.kind, status: t.status });
        continue;
      }
      const r = (t.result && typeof t.result === "object" ? t.result : {}) as { unresolvedEnv?: number; droppedInvalidKeys?: unknown[] };
      if (t.resourceType === "application" && t.resourceId) {
        const a = appById.get(t.resourceId);
        rt.apps.push({ itemRef: t.itemRef, name: a?.name ?? null, status: a?.status ?? "MISSING", envUnresolved: r.unresolvedEnv ?? 0, envDropped: Array.isArray(r.droppedInvalidKeys) ? r.droppedInvalidKeys.length : 0 });
      } else if (t.resourceType === "database" && t.resourceId) {
        const d = dbById.get(t.resourceId);
        rt.databases.push({ itemRef: t.itemRef, name: d?.name ?? null, status: d?.status ?? "MISSING" });
      }
    }
    return rt;
  }
}
