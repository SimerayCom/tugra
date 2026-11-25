import { DatastoreTuningService, safePgValue, safeRedisSize } from "./datastore-tuning.service";

function make(autoConf: Record<string, string> = {}, live: Record<string, string> = {}) {
  const executed: string[] = [];
  const prisma = {
    $queryRawUnsafe: jest.fn(async (sql: string, name: string) =>
      sql.includes("pg_file_settings") ? (autoConf[name] ? [{ v: autoConf[name] }] : []) : [{ v: live[name] ?? "x" }],
    ),
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      executed.push(sql);
      return 0;
    }),
  };
  const config = jest.fn(async () => "OK");
  const svc = new DatastoreTuningService(prisma as never, { client: { config } } as never);
  return { svc, executed, config };
}

describe("DatastoreTuningService", () => {
  it("applies only the profile values that are set, then reloads", async () => {
    const { svc, executed, config } = make();
    const res = await svc.apply({ TUGRA_PG_WORK_MEM: "2MB", TUGRA_PG_SHARED_BUFFERS: "64MB", TUGRA_REDIS_MAXMEMORY: "96mb" });
    expect(executed).toEqual(["ALTER SYSTEM SET shared_buffers = '64MB'", "ALTER SYSTEM SET work_mem = '2MB'", "SELECT pg_reload_conf()"]);
    expect(res.pending).toEqual(["shared_buffers"]);
    expect(config).toHaveBeenCalledWith("SET", "maxmemory", "96mb");
    expect(config).toHaveBeenCalledWith("SET", "maxmemory-policy", "noeviction");
  });

  it("an install without a profile changes nothing", async () => {
    const { svc, executed, config } = make();
    expect(await svc.apply({})).toEqual({ pg: [], pending: [], redis: false });
    expect(executed).toEqual([]);
    expect(config).not.toHaveBeenCalled();
  });

  it("does not rewrite a value already stored, and never inlines anything but a strict literal", async () => {
    const { svc, executed } = make({ work_mem: "2MB" });
    await svc.apply({ TUGRA_PG_WORK_MEM: "2MB", TUGRA_PG_MAX_WAL_SIZE: "1GB'; DROP TABLE x; --" });
    expect(executed).toEqual([]);
    expect(safePgValue("1GB'; DROP")).toBeNull();
    expect(safePgValue("5min")).toBe("5min");
    expect(safeRedisSize("256MB")).toBe("256mb");
    expect(safeRedisSize("256 mb")).toBeNull();
  });

  it("never throws when a statement fails", async () => {
    const { svc } = make();
    (svc as unknown as { prisma: { $executeRawUnsafe: jest.Mock } }).prisma.$executeRawUnsafe.mockRejectedValue(new Error("permission denied"));
    await expect(svc.apply({ TUGRA_PG_WORK_MEM: "2MB" })).resolves.toBeDefined();
  });
});
