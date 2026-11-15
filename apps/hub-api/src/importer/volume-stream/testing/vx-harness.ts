/** Test harness for VxService: in-memory-ish prisma mocks + agent/executor/token fakes. Not imported by production code. */
import { VxService } from "../vx.service";
import { APP_ID, DB_ID, SERVER_ID, TEAM_ID, opRow, probeOutput } from "./vx-fixtures";

export interface HarnessOpts {
  op?: Record<string, unknown>;
  app?: Record<string, unknown> | null;
  db?: Record<string, unknown> | null;
  server?: Record<string, unknown> | null;
  online?: boolean;
  supportsOrigin?: boolean;
  probe?: { exitCode: number; output: string } | Error;
}

export function harness(o: HarnessOpts = {}) {
  const op = opRow(o.op);
  const app = o.app === null ? null : { id: APP_ID, serverId: SERVER_ID, teamId: TEAM_ID, clusterId: null, name: "web", volumes: [{ name: "data", path: "/var/www/data" }], ...o.app };
  const db = o.db === null ? null : { id: DB_ID, serverId: SERVER_ID, teamId: TEAM_ID, engine: "POSTGRES", version: "16", image: "postgres:16-alpine", status: "NEW", name: "pg", ...o.db };
  const server = o.server === null ? null : { id: SERVER_ID, teamId: TEAM_ID, capabilities: ["backup", "deploy"], ...o.server };
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue(server) },
    application: { findUnique: jest.fn().mockResolvedValue(app), findMany: jest.fn().mockResolvedValue(app ? [app] : []) },
    database: { findUnique: jest.fn().mockResolvedValue(db), findMany: jest.fn().mockResolvedValue(db ? [db] : []) },
    restore: { count: jest.fn().mockResolvedValue(0) },
    backup: { count: jest.fn().mockResolvedValue(0) },
    deployment: { count: jest.fn().mockResolvedValue(0) },
    bulkOperation: { findUnique: jest.fn().mockResolvedValue({ meta: op.meta }) },
    bulkTask: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: "data-task" }), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}) },
    migrationVolumeTransfer: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    migrationVolumePart: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const executor = { loadIngestOp: jest.fn().mockResolvedValue(op) };
  const sendCommand = jest.fn().mockImplementation(async () => {
    if (o.probe instanceof Error) throw o.probe;
    return o.probe ?? { exitCode: 0, output: probeOutput("tugra_appv_" + APP_ID + "_data") };
  });
  const agentWs = {
    isOnline: jest.fn().mockReturnValue(o.online ?? true),
    agentSupports: jest.fn().mockReturnValue(o.supportsOrigin ?? true),
    sendCommand,
    cancelCommand: jest.fn(),
  };
  const tokens = { extend: jest.fn().mockResolvedValue(new Date(Date.now() + 3_600_000)) };
  const svc = new VxService(prisma as never, access as never, executor as never, agentWs as never, tokens as never);
  return { svc, prisma, access, executor, agentWs, tokens, op, app, db, server };
}
