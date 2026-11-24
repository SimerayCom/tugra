/** Test harness for VxService: in-memory tables + a fake target agent that really exercises the relay. Not imported by production code. */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { VolumeRelayService } from "../../../app-moves/volume-relay.service";
import { VxService } from "../vx.service";
import { VxPartRegistry } from "../vx-part-registry";
import { APP_ID, DB_ID, SERVER_ID, TEAM_ID, opRow, probeOutput } from "./vx-fixtures";
import { memParts, memTasks, memTransaction, memTransfers } from "./vx-memdb";

export interface HarnessOpts {
  op?: Record<string, unknown>;
  app?: Record<string, unknown> | null;
  db?: Record<string, unknown> | null;
  server?: Record<string, unknown> | null;
  online?: boolean;
  supportsOrigin?: boolean;
  probe?: { exitCode: number; output: string } | Error;
  /** Free KiB reported by the target probe (both staging and docker root, same device). */
  freeKb?: number;
  relayConcurrency?: number;
  /** The guided run this op belongs to (its stored options), or none: a plain `migrate` op. */
  run?: { options: unknown } | null;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export function harness(o: HarnessOpts = {}) {
  const op = opRow(o.op);
  const app = o.app === null ? null : { id: APP_ID, serverId: SERVER_ID, teamId: TEAM_ID, clusterId: null, name: "web", volumes: [{ name: "data", path: "/var/www/data" }], ...o.app };
  const db = o.db === null ? null : { id: DB_ID, serverId: SERVER_ID, teamId: TEAM_ID, engine: "POSTGRES", version: "16", image: "postgres:16-alpine", status: "NEW", name: "pg", ...o.db };
  const server = o.server === null ? null : { id: SERVER_ID, teamId: TEAM_ID, capabilities: ["backup", "deploy"], ...o.server };
  const transfers = memTransfers();
  const parts = memParts();
  const tasks = memTasks();
  // the op's own provisioning tasks live in loadIngestOp's result; data tasks live in the mem table
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue(server) },
    application: { findUnique: jest.fn().mockResolvedValue(app), findMany: jest.fn().mockResolvedValue(app ? [app] : []) },
    database: { findUnique: jest.fn().mockResolvedValue(db), findMany: jest.fn().mockResolvedValue(db ? [db] : []) },
    restore: { count: jest.fn().mockResolvedValue(0) },
    backup: { count: jest.fn().mockResolvedValue(0) },
    deployment: { count: jest.fn().mockResolvedValue(0) },
    bulkOperation: { findUnique: jest.fn().mockImplementation(async () => ({ meta: op.meta })) },
    migrationRun: { findFirst: jest.fn().mockResolvedValue(o.run ?? null) },
    bulkTask: tasks,
    migrationVolumeTransfer: transfers,
    migrationVolumePart: parts,
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: undefined as unknown as jest.Mock,
  };
  prisma.$transaction = jest.fn(memTransaction({ migrationVolumeTransfer: transfers, migrationVolumePart: parts, bulkTask: tasks }));
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const executor = { loadIngestOp: jest.fn().mockImplementation(async () => ({ ...op, tasks: [...(op.tasks as unknown[]), ...tasks.rows] })) };

  const relay = new VolumeRelayService({ get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? "test-secret-0123456789" : k === "MIGRATION_RELAY_CONCURRENCY" ? o.relayConcurrency : undefined) } as never);
  const registry = new VxPartRegistry();
  const apply = {
    start: jest.fn(),
    retryProvision: jest.fn(),
    resumeAfterApplied: jest.fn(),
    cleanupTarget: jest.fn().mockResolvedValue(true),
    wipeDest: jest.fn().mockResolvedValue(undefined),
    probeTargetState: jest.fn(),
    isRunning: jest.fn().mockReturnValue(false),
  };
  const tokens = { extend: jest.fn().mockResolvedValue(new Date(Date.now() + 3_600_000)) };

  // ── the fake TARGET agent: dispatches by script content; the receive script really pulls the part through the relay ──
  const staged = new Map<number, Buffer>(); // part idx -> bytes staged on the target (what `p.NNNNN` would hold)
  const recvOverride: { fail?: { exitCode: number; output: string }; hang?: boolean } = {};
  const cmds: string[] = [];
  const sendCommand = jest.fn().mockImplementation(async (_server: string, script: string) => {
    cmds.push(script);
    if (script.includes("TUGRA_PROBE_END")) {
      if (o.probe instanceof Error) throw o.probe;
      const vol = /TUGRA_VOL (\S+) (?:ABSENT|EXISTS)/.exec(script)?.[1] ?? "tugra_appv_" + APP_ID + "_data";
      return o.probe ?? { exitCode: 0, output: probeOutput(vol, { stageKb: o.freeKb, dockerKb: o.freeKb, sameDev: true }) };
    }
    if (script.includes("TUGRA_VX_RECV_OK")) {
      if (recvOverride.hang) return new Promise(() => undefined);
      if (recvOverride.fail) return recvOverride.fail;
      // The recv script hands curl the signed relay path through a private -K config file: the path travels base64-encoded
      // inside a `printf %s '<b64>' | base64 -d` pipeline (see relayCredentialLines), so decode it the way the shell would.
      const b64 = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)?.[1];
      const decoded = b64 ? Buffer.from(b64, "base64").toString("utf8") : script;
      const m = /\/api\/v1\/agent-vx\/t\/([A-Za-z0-9_-]+)\?exp=(\d+)&sig=([A-Za-z0-9_-]+)/.exec(decoded);
      const partM = /p\.(\d{5})/.exec(script);
      if (!m || !partM) return { exitCode: 64, output: "bad recv script" };
      const file = relay.serveToTarget(m[1], m[2], m[3]);
      const chunks: Buffer[] = [];
      try {
        for await (const c of file.getStream()) chunks.push(c as Buffer);
      } catch {
        return { exitCode: 18, output: "curl: (18) transfer closed with outstanding read data remaining" };
      }
      const body = Buffer.concat(chunks);
      const size = Number(/-s "\$F\.tmp"\)" = "(\d+)"/.exec(script)?.[1] ?? /stat -c %s "\$F\.tmp"\)" = "(\d+)"/.exec(script)?.[1]);
      const want = /cut -d' ' -f1\)" = "([0-9a-f]{64})"/.exec(script)?.[1];
      if (body.length !== size) return { exitCode: 65, output: "size mismatch" };
      if (sha(body) !== want) return { exitCode: 66, output: "sha mismatch" };
      staged.set(Number(partM[1]), body);
      return { exitCode: 0, output: "TUGRA_VX_RECV_OK\n" };
    }
    if (script.includes("TUGRA_VX_PART")) {
      const idx = Number(/p\.(\d{5})/.exec(script)?.[1]);
      const b = staged.get(idx);
      return b ? { exitCode: 0, output: `TUGRA_VX_PART ${b.length} ${sha(b)}\n` } : { exitCode: 66, output: "part missing" };
    }
    return { exitCode: 0, output: "" };
  });
  const agentWs = {
    isOnline: jest.fn().mockReturnValue(o.online ?? true),
    agentSupports: jest.fn().mockReturnValue(o.supportsOrigin ?? true),
    sendCommand,
    cancelCommand: jest.fn(),
  };
  const svc = new VxService(prisma as never, access as never, executor as never, agentWs as never, tokens as never, relay, registry, apply as never);

  /** The SOURCE side of one part: PUT the bytes to the signed relay path the hub handed out. */
  async function put(srcPath: string, body: Buffer, contentLength = body.length): Promise<void> {
    const m = /\/api\/v1\/agent-vx\/t\/([A-Za-z0-9_-]+)\?exp=(\d+)&sig=([A-Za-z0-9_-]+)/.exec(srcPath);
    if (!m) throw new Error(`bad src path ${srcPath}`);
    const stream = Readable.from(
      (function* () {
        for (let i = 0; i < body.length; i += 7) yield body.subarray(i, i + 7);
      })(),
    ) as Readable & { headers: Record<string, string> };
    stream.headers = { "content-length": String(contentLength) };
    await relay.receiveFromSource(m[1], m[2], m[3], stream as unknown as IncomingMessage);
  }

  return { svc, prisma, access, executor, agentWs, tokens, op, app, db, server, relay, registry, apply, transfers, parts, tasks, staged, recvOverride, cmds, put, sendCommand };
}

export type Harness = ReturnType<typeof harness>;
