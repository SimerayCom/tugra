/**
 * A small in-memory world for the app-move runner/recovery/sweeper specs: stateful fake Prisma tables (with a
 * snapshot-and-restore interactive transaction), a scripted agent fleet, a fake deploy queue and the collaborators the
 * runner needs. Everything the real code does to the database is visible in `world.*`, and every agent command is
 * recorded in `world.commands`, so the specs assert on observable state and ordering instead of mock call counts.
 */
import { Prisma } from "@prisma/client";
import { AppMoveRunnerService } from "../app-move-runner.service";
import { MOVE_STAGING_ROOT } from "../app-move-scripts";

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Deep clone that keeps Dates in the TEST realm (structuredClone would hand back foreign-realm Dates). */
const clone = <T>(v: T): T => {
  if (v === null || typeof v !== "object") return v;
  if (Object.prototype.toString.call(v) === "[object Date]") return new Date((v as unknown as Date).getTime()) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => clone(x)) as unknown as T;
  return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, clone(x)])) as T;
};

/** where-clause matcher for the shapes the runner uses (equality, in/notIn/not/startsWith/lt, OR/AND/NOT). */
export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "AND") {
      if (!(cond as Row[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "NOT") {
      if (matches(row, cond as Row)) return false;
      continue;
    }
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c = cond as Row;
      if ("in" in c && !(c.in as unknown[]).includes(v)) return false;
      if ("notIn" in c && (c.notIn as unknown[]).includes(v)) return false;
      if ("not" in c && (c.not === null ? v === null : typeof c.not === "object" ? matches({ x: v }, { x: c.not }) : v === c.not)) return false;
      if ("startsWith" in c && !(typeof v === "string" && v.startsWith(c.startsWith as string))) return false;
      if ("lt" in c && !(v != null && v < (c.lt as never))) return false;
      continue;
    }
    if (cond instanceof Date ? v?.getTime?.() !== cond.getTime() : v !== cond) return false;
  }
  return true;
}

class Table {
  constructor(public rows: Row[], private readonly key = "id") {}
  find(where: Row | undefined): Row[] {
    return this.rows.filter((r) => matches(r, where));
  }
  api(world: FakeWorld, name: string) {
    const sel = (r: Row | undefined, select?: Row): Row | null => (r ? (select ? Object.fromEntries(Object.keys(select).map((k) => [k, clone(r[k])])) : clone(r)) : null);
    return {
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        const w = this.flatten(where);
        return sel(this.find(w)[0], select);
      },
      findFirst: async ({ where, select, orderBy }: { where?: Row; select?: Row; orderBy?: Row }) => {
        let rows = this.find(where);
        if (orderBy) {
          const [[k, dir]] = Object.entries(orderBy);
          rows = [...rows].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === "desc" ? -1 : 1));
        }
        return sel(rows[0], select);
      },
      findMany: async ({ where, select, orderBy, take }: { where?: Row; select?: Row; orderBy?: Row; take?: number } = {}) => {
        let rows = this.find(where);
        if (orderBy) {
          const [[k, dir]] = Object.entries(orderBy);
          rows = [...rows].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === "desc" ? -1 : 1));
        }
        return rows.slice(0, take ?? rows.length).map((r) => sel(r, select)!);
      },
      count: async ({ where }: { where?: Row } = {}) => this.find(where).length,
      updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
        const rows = this.find(where);
        for (const r of rows) world.apply(name, r, data);
        return { count: rows.length };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const r = this.find(this.flatten(where))[0];
        if (!r) throw new Error(`${name}: record not found`);
        world.apply(name, r, data);
        return clone(r);
      },
      create: async ({ data }: { data: Row }) => {
        const r = { id: `${name}-${this.rows.length + 1}`, ...clone(data) };
        this.rows.push(r);
        return clone(r);
      },
    };
  }
  /** `appId_idempotencyKey: {appId, idempotencyKey}` compound uniques flatten to plain equality. */
  private flatten(where: Row): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(where)) {
      if (k.includes("_") && v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((kk) => k.includes(kk))) Object.assign(out, v);
      else out[k] = v;
    }
    return out;
  }
}

export interface CommandRecord {
  server: string;
  cap: string;
  script: string;
  kind: string;
  phase: string | undefined;
  appServerId: string | undefined;
}

export interface WorldOptions {
  status?: "NEW" | "RUNNING" | "STOPPED" | "FAILED";
  cheap?: boolean;
  volumes?: Row[];
  app?: Row;
  retainDays?: number;
  repointDns?: boolean;
  acks?: Row;
  plan?: Row;
  moveRow?: Row;
}

export const MOVE_ID = "ckmoveabcdefghijklmnopqrs";
export const APP_ID = "ckappabcdefghijklmnopqrstu";

/** Classify an agent command by its content. */
export function kindOf(script: string): string {
  if (script.includes("TUGRA_VX_CREATED")) return "prepare";
  if (script.includes("TUGRA_VX_PACKED")) return "pack";
  if (script.includes("TUGRA_VX_PART ") && script.includes("stat -c")) return script.includes("head -c") ? "linkfile" : "stat";
  if (script.includes("TUGRA_VX_SEND_OK")) return "send";
  if (script.includes("TUGRA_VX_RECV_OK")) return "recv";
  if (script.includes("TUGRA_VX_APPLY_OK")) return "apply";
  if (script.includes("TUGRA_VX_QUIESCED")) return "verify";
  if (script.includes("TUGRA_VX_CLEANUP_DONE")) return script.includes("rm -rf") ? "cleanup" : "archive-purge";
  if (/^rm -f /.test(script)) return "drop";
  if (script.startsWith("docker stop") || script.includes("compose") && script.includes(" stop")) return "stop";
  if (script.startsWith("docker start") || script.includes("compose") && script.includes(" start")) return "start";
  if (script.includes("docker rm -f") || script.includes("compose") && script.includes(" down")) return "remove";
  return "other";
}

export class FakeWorld {
  app: Row;
  move: Row;
  servers: Record<string, Row>;
  deployments: Row[] = [];
  logDrains: Row[];
  volumeBackups: Row[];
  domains: Row[] = [];
  databases: Row[] = [];
  otherApps: Row[] = [];
  commands: CommandRecord[] = [];
  phases: string[] = [];
  audits: Row[] = [];
  events: { teamId: string; type: string; ctx: Row }[] = [];
  drains: string[] = [];
  /** which hosts currently run the app's container */
  running: Record<string, boolean> = { s1: true, s2: false };
  online: Record<string, boolean> = { s1: true, s2: true };
  volumesOnHost: Record<string, Set<string>> = { s1: new Set(), s2: new Set() };

  /** scripted behaviour: kind -> handler(call#, server, script) -> result | throws; first match wins */
  handlers: Record<string, ((n: number, server: string, script: string) => { exitCode: number; output: string } | undefined)[]> = {};
  counts: Record<string, number> = {};
  /** transfer results consumed in order; empty = success */
  transferResults: Row[] = [];
  transferCalls = 0;
  /** deploy outcome per call index (key suffix) : "SUCCESS" | "FAILED" | "HANG" */
  deployOutcomes: Record<string, "SUCCESS" | "FAILED" | "HANG"> = {};
  deployDelayMs = 1;
  preflight: () => Row = () => this.okPreflight();
  /** run before each agent command (cancel injection, crash injection, invariants) */
  beforeCommand?: (rec: CommandRecord) => void | Promise<void>;
  snapshotsTaken = 0;
  /** persisted-state snapshots taken at every command boundary (crash points) */
  crashPoints: { snap: { t: Record<string, Row[]>; ph: string[] }; running: Record<string, boolean>; kind: string }[] = [];
  recordCrashPoints = false;

  appMove: ReturnType<Table["api"]>;
  prisma: Row;
  runner!: AppMoveRunnerService;
  apps: Row;
  agentWs: Row;
  transfers: Row;
  portAlloc: Row;
  dns: Row;
  notifications: Row;
  audit: Row;
  lease = { bootId: "boot-1" };
  preflights: Row;

  private tables: Record<string, Table>;

  constructor(o: WorldOptions = {}) {
    const vols = o.volumes ?? [{ name: "data", dockerName: "tugra_appv_ckappabcdefghijklmnopqrstu_data", kind: "app", sizeBytes: 4096, state: "PENDING", parts: 0, partsDone: 0, bytesDone: 0, entries: null, createdOnTarget: false, archiveOverwritten: false }];
    this.app = {
      id: APP_ID, name: "blog", teamId: "t1", serverId: "s1", status: o.status ?? "RUNNING", source: "IMAGE", hostPort: null, domain: null, domainKind: "none",
      composeFile: null, configMounts: null, templateSlug: null, cpusetCpus: null, gpus: null, clusterId: null, allowPrivilegedDockerOptions: false, dockerOptions: null,
      tunnelExposed: false, certPem: null, environmentId: "e1", ...o.app,
    };
    this.servers = {
      s1: { id: "s1", name: "alpha", teamId: "t1", publicIp: "1.2.3.4", publicIpv6: null, wildcardDomain: null, magicSuffix: null, proxyBind: "all", cpuCores: 8, gpuInventory: null },
      s2: { id: "s2", name: "beta", teamId: "t1", publicIp: "5.6.7.8", publicIpv6: null, wildcardDomain: null, magicSuffix: null, proxyBind: "all", cpuCores: 8, gpuInventory: null },
    };
    for (const v of vols) if (v.state !== "SKIPPED") this.volumesOnHost.s1.add(v.dockerName);
    this.running = { s1: this.app.status === "RUNNING", s2: false };
    const cheap = o.cheap ?? this.app.status === "NEW";
    this.move = {
      id: MOVE_ID, appId: APP_ID, appName: "blog", teamId: "t1", requestedBy: "u1", sourceServerId: "s1", targetServerId: "s2", phase: "QUEUED", prevStatus: this.app.status,
      plan: { cheap, totalBytes: 4096, partBytes: 1024, hostPort: { from: null, to: null }, domain: { kind: "none", from: null, to: null }, volumes: vols.map((v) => ({ dockerName: v.dockerName, state: v.state === "SKIPPED" ? "absent_skip" : "move" })), ...o.plan },
      acks: o.acks ?? {}, repointDns: o.repointDns ?? false, retainDays: o.retainDays ?? 7, volumes: vols, snapshotBefore: null, deploymentId: null, warnings: [], failureReason: null,
      failurePhase: null, logTail: null, cancelRequested: false, ownerId: null, heartbeatAt: null, deadlineAt: null, startedAt: null, cutoverAt: null, finishedAt: null,
      archiveUntil: null, sourcePurgedAt: null, targetPurgedAt: null, createdAt: new Date(), ...o.moveRow,
    };
    this.logDrains = [{ id: "ld1", appId: APP_ID, serverId: "s1" }, { id: "ld-server-wide", appId: null, serverId: "s1" }];
    this.volumeBackups = [
      { id: "vb-local", appId: APP_ID, destinationId: null, hostServerId: null },
      { id: "vb-s3", appId: APP_ID, destinationId: "dest-s3", hostServerId: null },
      { id: "vb-localdest", appId: APP_ID, destinationId: "dest-local", hostServerId: null },
    ];
    this.tables = {
      appMove: new Table([this.move]),
      application: new Table([this.app]),
      server: new Table(Object.values(this.servers)),
      deployment: new Table(this.deployments),
      logDrain: new Table(this.logDrains),
      volumeBackup: new Table(this.volumeBackups),
      domain: new Table(this.domains),
      database: new Table(this.databases),
      backupDestination: new Table([{ id: "dest-local", teamId: "t1", type: "LOCAL" }, { id: "dest-s3", teamId: "t1", type: "S3" }]),
    };
    // otherApps live in the application table too (target-port reservations)
    this.appMove = this.tables.appMove.api(this, "appMove");
    const db: Row = {};
    for (const [n, t] of Object.entries(this.tables)) db[n] = t.api(this, n);
    db.application.findMany = async ({ where, select }: { where?: Row; select?: Row } = {}) =>
      [...this.tables.application.find(where), ...this.otherApps.filter((r) => matches(r, where))].map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, clone(r[k])])) : clone(r)));
    db.$queryRaw = async () => [];
    db.$transaction = async (cb: (tx: Row) => Promise<unknown>) => {
      const snap = this.snapshot();
      try {
        return await cb(db);
      } catch (e) {
        this.restore(snap);
        throw e;
      }
    };
    this.prisma = db;

    this.agentWs = {
      isOnline: (id: string) => this.online[id] !== false,
      cancelCommand: jest.fn().mockReturnValue(true),
      sendCommand: async (server: string, script: string, cap: string, _t: number, _c: unknown, onStart?: (id: string) => void) => {
        if (this.online[server] === false) throw new Error("agent offline");
        onStart?.(`req-${this.commands.length}`);
        const kind = kindOf(script);
        const rec: CommandRecord = { server, cap, script, kind, phase: this.move.phase, appServerId: this.app.serverId };
        this.commands.push(rec);
        if (this.recordCrashPoints) this.crashPoints.push({ snap: this.snapshot(), running: { ...this.running }, kind });
        await this.beforeCommand?.(rec);
        this.counts[kind] = (this.counts[kind] ?? 0) + 1;
        for (const h of this.handlers[kind] ?? []) {
          const r = h(this.counts[kind], server, script);
          if (r) return r;
        }
        return this.defaultCommand(server, script, kind);
      },
    };
    this.apps = {
      moveLifecycle: async (a: Row) => ({
        stop: `docker stop tugra_${a.id} 2>/dev/null || true`,
        start: `docker start tugra_${a.id}`,
        removeContainer: `docker rm -f tugra_${a.id} 2>/dev/null || true`,
        timeoutMs: 1000,
      }),
      submitMoveDeploy: async (appId: string, actor: string, key: string) => {
        // crash points around the enqueue: DEPLOYING with no row yet, and with the row but no deploymentId stored
        if (this.recordCrashPoints) this.crashPoints.push({ snap: this.snapshot(), running: { ...this.running }, kind: "before-deploy" });
        const d = this.submitDeploy(appId, actor, key);
        if (this.recordCrashPoints) this.crashPoints.push({ snap: this.snapshot(), running: { ...this.running }, kind: "after-deploy-enqueue" });
        return d;
      },
      drainApp: async (id: string) => void this.drains.push(id),
      syncAfterMove: async () => [] as string[],
      cancelMoveDeployment: async (depId: string) => {
        const d = this.deployments.find((x) => x.id === depId);
        if (d && (d.status === "QUEUED" || d.status === "RUNNING")) d.status = "CANCELLED";
        return !!d;
      },
    };
    this.transfers = {
      transfer: async (req: Row, onHandle?: (h: { cancel(e: Error): void }) => void) => {
        this.transferCalls++;
        onHandle?.({ cancel: () => undefined });
        this.world_transferReq = req;
        const r = this.transferResults.shift();
        return r ?? { ok: true, bytes: req.size };
      },
    };
    this.portAlloc = { probeUsedPorts: async () => new Set<number>(), allocate: jest.fn(async () => [20001]) };
    this.dns = { previewRecords: jest.fn().mockResolvedValue({ records: [] }), applyRecords: jest.fn().mockResolvedValue({}) };
    this.notifications = { fireForEvent: jest.fn(async (teamId: string, type: string, ctx: Row) => void this.events.push({ teamId, type, ctx })) };
    this.audit = { log: jest.fn(async (e: Row) => void this.audits.push(e)) };
    this.preflights = { computePreflight: jest.fn(async () => this.preflight()) };
  }

  world_transferReq: Row | undefined;

  okPreflight(): Row {
    const plan = this.move.plan;
    return {
      ok: true,
      blockers: [],
      warnings: [],
      requiredAcks: [],
      plan: { cheap: plan.cheap, volumes: (plan.volumes as Row[]).map((v) => ({ ...v })), hostPort: plan.hostPort, domain: plan.domain, totalBytes: plan.totalBytes },
    };
  }

  /** Apply a Prisma-style data object (phase transitions are recorded). */
  apply(table: string, row: Row, data: Row): void {
    for (const [k, v] of Object.entries(data)) {
      row[k] = v === Prisma.DbNull || v === Prisma.JsonNull ? null : v;
    }
    if (table === "appMove" && typeof data.phase === "string" && this.phases[this.phases.length - 1] !== data.phase) this.phases.push(data.phase);
  }

  snapshot(): { t: Record<string, Row[]>; ph: string[] } {
    this.snapshotsTaken++;
    return { t: Object.fromEntries(Object.entries(this.tables).map(([k, t]) => [k, t.rows.map((r) => clone(r))])), ph: [...this.phases] };
  }

  /** Roll back an aborted transaction IN PLACE (the specs hold references to the live rows); rows the snapshot has
   *  that the table lacks (a recovered world) are re-added. */
  restore(snap: { t: Record<string, Row[]>; ph: string[] }): void {
    for (const [k, saved] of Object.entries(snap.t)) {
      const t = this.tables[k];
      const byId = new Map(saved.map((r) => [r.id, r]));
      for (let i = t.rows.length - 1; i >= 0; i--) {
        const r = t.rows[i];
        const sv = byId.get(r.id);
        if (!sv) {
          t.rows.splice(i, 1);
          continue;
        }
        for (const key of Object.keys(r)) delete r[key];
        Object.assign(r, clone(sv));
        byId.delete(r.id);
      }
      for (const sv of byId.values()) t.rows.push(clone(sv));
    }
    this.phases = snap.ph;
  }

  /** After restoring a crash snapshot: deployments that were in flight settle on their own (the deploy engine's own
   *  recovery owns them in production) with the outcome the test scripted. */
  settlePending(): void {
    for (const d of this.deployments) {
      if (d.status !== "RUNNING" && d.status !== "QUEUED") continue;
      const outcome = this.deployOutcomes[String(d.idempotencyKey).endsWith(":rb") ? "rb" : "move"] ?? "SUCCESS";
      if (outcome === "HANG") continue;
      setTimeout(() => {
        if (d.status !== "RUNNING" && d.status !== "QUEUED") return;
        d.status = outcome;
        const a = this.app;
        if (outcome === "SUCCESS") {
          a.status = "RUNNING";
          this.running[a.serverId] = true;
        } else a.status = "FAILED";
      }, this.deployDelayMs);
    }
  }

  private submitDeploy(appId: string, actor: string, key: string): Row {
    const d: Row = { id: `dep-${this.deployments.length + 1}`, appId, status: "RUNNING", idempotencyKey: key, requestedBy: actor, trigger: "move" };
    this.deployments.push(d);
    const suffix = key.endsWith(":rb") ? "rb" : "move";
    const outcome = this.deployOutcomes[suffix] ?? "SUCCESS";
    if (outcome !== "HANG") {
      setTimeout(() => {
        if (d.status !== "RUNNING") return;
        d.status = outcome;
        if (outcome === "SUCCESS") {
          const a = this.tables.application.find({ id: appId })[0];
          if (a) {
            a.status = "RUNNING";
            this.running[a.serverId] = true;
          }
        } else {
          const a = this.tables.application.find({ id: appId })[0];
          if (a) a.status = "FAILED";
        }
      }, this.deployDelayMs);
    }
    return clone(d);
  }

  private defaultCommand(server: string, script: string, kind: string): { exitCode: number; output: string } {
    switch (kind) {
      case "prepare": {
        const names = [...script.matchAll(/TUGRA_VX_CREATED (\S+) 1/g)].map((m) => m[1]);
        const existing = [...this.volumesOnHost[server]];
        return { exitCode: 0, output: names.map((n) => `TUGRA_VX_CREATED ${n} ${existing.includes(n) ? 0 : 1}`).join("\n") + "\n" };
      }
      case "pack": return { exitCode: 0, output: "TUGRA_VX_PACKED parts=3 entries=5\n" };
      case "stat": return { exitCode: 0, output: `TUGRA_VX_PART 1024 ${"a".repeat(64)}\n` };
      case "apply": return { exitCode: 0, output: "TUGRA_RESTORE_OK\nTUGRA_VX_APPLY_OK entries=5\n" };
      case "verify": return this.running[server] ? { exitCode: 1, output: "TUGRA_VX_RUNNING\n" } : { exitCode: 0, output: "TUGRA_VX_QUIESCED\n" };
      case "stop": this.running[server] = false; return { exitCode: 0, output: "" };
      case "start": this.running[server] = true; return { exitCode: 0, output: "" };
      case "remove": this.running[server] = false; return { exitCode: 0, output: "" };
      case "cleanup": {
        const names = [...script.matchAll(/TUGRA_VX_VOL (\S+) removed/g)].map((m) => m[1]);
        return { exitCode: 0, output: names.map((n) => `TUGRA_VX_VOL ${n} removed`).join("\n") + "\nTUGRA_VX_CLEANUP_DONE\n" };
      }
      case "archive-purge": {
        const names = [...script.matchAll(/TUGRA_VX_VOL (\S+) removed/g)].map((m) => m[1]);
        return { exitCode: 0, output: names.map((n) => `TUGRA_VX_VOL ${n} removed`).join("\n") + "\nTUGRA_VX_CLEANUP_DONE\n" };
      }
      default: return { exitCode: 0, output: "" };
    }
  }

  /** Build the runner under test with every collaborator faked, timing shrunk to a few ms. */
  build(): AppMoveRunnerService {
    this.runner = new AppMoveRunnerService(
      this.prisma as never, this.agentWs as never, this.apps as never, this.preflights as never, this.transfers as never,
      this.portAlloc as never, this.dns as never, this.notifications as never, this.audit as never, this.lease as never,
    );
    this.runner.timing = { heartbeatMs: 5, deployPollMs: 2, partRetryBackoffMs: 1, busyBackoffMs: 1, busyBackoffMaxMs: 2, cancelWaitMs: 50 };
    return this.runner;
  }

  onHost(kind: string): CommandRecord[] {
    return this.commands.filter((c) => c.kind === kind);
  }
  kinds(): string[] {
    return this.commands.map((c) => `${c.kind}@${c.server}`);
  }
  get stagingRoot(): string {
    return MOVE_STAGING_ROOT;
  }
}
