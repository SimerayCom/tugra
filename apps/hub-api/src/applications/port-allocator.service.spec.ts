import { PortAllocatorService, parseProbe } from "./port-allocator.service";

function make(opts: {
  apps?: { hostPort?: number | null; portMappings?: unknown }[];
  dbs?: { hostPort?: number | null }[];
  online?: boolean;
  probeOutput?: string;
  min?: number;
  max?: number;
} = {}) {
  const executeRaw = jest.fn().mockResolvedValue(1);
  const prisma: Record<string, unknown> = {
    application: { findMany: jest.fn().mockResolvedValue(opts.apps ?? []) },
    database: { findMany: jest.fn().mockResolvedValue(opts.dbs ?? []) },
    $executeRaw: executeRaw,
  };
  prisma.$transaction = jest.fn((cb: (c: unknown) => unknown) => cb(prisma));
  const agentWs = {
    isOnline: jest.fn().mockReturnValue(opts.online ?? false),
    sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: opts.probeOutput ?? "" }),
  };
  const config = {
    get: jest.fn((k: string) => ({ TUGRA_HOSTPORT_MIN: opts.min ?? 20000, TUGRA_HOSTPORT_MAX: opts.max ?? 45000 })[k]),
  };
  return {
    svc: new PortAllocatorService(prisma as never, agentWs as never, config as never),
    prisma,
    agentWs,
    executeRaw,
  };
}

describe("parseProbe", () => {
  it("extracts host ports from `ss -ltnH` local addresses and docker published mappings", () => {
    const out = [
      "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
      "LISTEN 0 128 127.0.0.1:20001 0.0.0.0:*",
      "LISTEN 0 128 [::]:20002 [::]:*",
      "LISTEN 0 128 *:20005 *:*",
      "0.0.0.0:20003->80/tcp, :::20003->80/tcp",
      "20004/tcp", // container-only, NOT host-published → ignored
      "", // blank
    ].join("\n");
    const ports = parseProbe(out);
    expect([...ports].sort((a, b) => a - b)).toEqual([22, 20001, 20002, 20003, 20005]);
    expect(ports.has(20004)).toBe(false); // not published to the host
  });

  it("is malformed-safe (no crash, skips non-numeric)", () => {
    expect(parseProbe("garbage\n:::\nLISTEN weird:notaport\n").size).toBe(0);
  });
});

describe("PortAllocatorService.allocate", () => {
  it("returns `count` distinct ports in range, ascending, on an empty server (offline)", async () => {
    const { svc } = make();
    expect(await svc.allocate("s1", 3)).toEqual([20000, 20001, 20002]);
  });

  it("skips ports already used by apps (hostPort + portMappings) and databases on that server", async () => {
    const { svc } = make({
      apps: [{ hostPort: 20000, portMappings: [{ hostPort: 20001 }] }],
      dbs: [{ hostPort: 20002 }],
    });
    expect(await svc.allocate("s1", 3)).toEqual([20003, 20004, 20005]);
  });

  it("probes the agent (deploy cap, fixed command) when online and skips listening ports", async () => {
    const { svc, agentWs } = make({
      online: true,
      probeOutput: "LISTEN 0 128 0.0.0.0:20000 0.0.0.0:*\n0.0.0.0:20001->80/tcp",
    });
    expect(await svc.allocate("s1", 2)).toEqual([20002, 20003]);
    expect(agentWs.sendCommand).toHaveBeenCalledTimes(1);
    const [serverId, cmd, cap] = agentWs.sendCommand.mock.calls[0];
    expect(serverId).toBe("s1");
    expect(cap).toBe("deploy");
    expect(cmd).toContain("ss -ltn");
    expect(cmd).toContain("docker ps");
    // command carries no interpolated serverId/count → injection-proof
    expect(cmd).not.toContain("s1");
  });

  it("does NOT probe when the agent is offline (DB-only reservation)", async () => {
    const { svc, agentWs } = make({ online: false });
    await svc.allocate("s1", 1);
    expect(agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("degrades gracefully when the probe throws (falls back to DB-only)", async () => {
    const { svc, agentWs } = make({ online: true });
    agentWs.sendCommand.mockRejectedValueOnce(new Error("command timed out"));
    expect(await svc.allocate("s1", 1)).toEqual([20000]); // probe failure is non-fatal
  });

  it("acquires a per-server advisory lock (race-safe reservation)", async () => {
    const { svc, executeRaw } = make();
    await svc.allocate("s1", 1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, value] = executeRaw.mock.calls[0];
    expect(strings.join("")).toContain("pg_advisory_xact_lock");
    expect(value).toBe("s1"); // parameterized (not interpolated)
  });

  it("throws when the range is exhausted", async () => {
    const { svc } = make({ min: 20000, max: 20001, apps: [{ hostPort: 20000 }, { hostPort: 20001 }] });
    await expect(svc.allocate("s1", 1)).rejects.toThrow();
  });

  it("runs inside a caller-supplied transaction (does not open its own)", async () => {
    const { svc, prisma } = make();
    const txExec = jest.fn().mockResolvedValue(1);
    const tx = {
      $executeRaw: txExec,
      application: { findMany: jest.fn().mockResolvedValue([]) },
      database: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const out = await svc.allocate("s1", 1, tx as never);
    expect(out).toEqual([20000]);
    expect(txExec).toHaveBeenCalledTimes(1); // lock taken on the caller's tx
    expect(prisma.$transaction).not.toHaveBeenCalled(); // no nested transaction
  });
});
