import { createPublicKey, verify } from "node:crypto";
import {
  AGENT_FEATURE_DRAIN_FLUENTD,
  AGENT_FEATURE_DRAIN_GELF,
  AGENT_FEATURE_DRAIN_SYSLOG,
  AGENT_FEATURE_LOG_DRAINS_V2,
  canonicalLogDrains,
} from "@tugra/shared";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { HubSigningService } from "../agent-gateway/hub-signing.service";
import { CryptoService } from "../crypto/crypto.service";
import { PrismaService } from "../prisma/prisma.service";
import { LogDrainPushService, sanitizeHost } from "./log-drain-push.service";

const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => {
    if (s === "enc:BROKEN") throw new Error("bad ciphertext");
    return s.replace(/^enc:/, "");
  },
} as unknown as CryptoService;

const row = (over: Record<string, unknown> = {}) => ({
  id: "d1", serverId: "s1", appId: null, name: "n", type: "http", endpoint: "https://a", authTokenEnc: null, enabled: true,
  containers: [], options: null, allowPrivate: false, createdAt: new Date(), ...over,
});

function make(rows: unknown[], opts: { v2?: boolean | string[]; logsGranted?: boolean; server?: object | null } = {}) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = {
    server: {
      findUnique: jest.fn().mockResolvedValue(opts.server === undefined ? { name: "web 01", clusterId: null } : opts.server),
      findMany: jest.fn().mockResolvedValue([{ id: "s1" }, { id: "s2" }]),
    },
    logDrain: { findMany },
  } as unknown as PrismaService;
  const features = new Set<string>(Array.isArray(opts.v2) ? opts.v2 : opts.v2 ? [AGENT_FEATURE_LOG_DRAINS_V2, AGENT_FEATURE_DRAIN_SYSLOG, AGENT_FEATURE_DRAIN_GELF, AGENT_FEATURE_DRAIN_FLUENTD] : []);
  const sendToAgent = jest.fn().mockReturnValue(true);
  const agentWs = {
    sendToAgent,
    agentSupports: jest.fn((_id: string, f: string) => features.has(f)),
    isCapabilityGranted: jest.fn().mockResolvedValue(opts.logsGranted ?? true),
    isOnline: jest.fn().mockReturnValue(true),
  } as unknown as AgentWsServer;
  return { svc: new LogDrainPushService(prisma, crypto, agentWs), prisma, findMany, sendToAgent, agentWs };
}

const v2Frame = (sendToAgent: jest.Mock) => {
  const msg = sendToAgent.mock.calls.at(-1)![1] as { type: string; serverId: string; rev: number; capability: string; drainsJson: string };
  return { msg, drains: JSON.parse(msg.drainsJson) as Record<string, unknown>[] };
};

describe("LogDrainPushService: legacy frame (byte-identical to pre-D7)", () => {
  it("pushToAgent sends only enabled drains with their type + decrypted tokens", async () => {
    const { svc, findMany, sendToAgent } = make([row({ type: "loki", authTokenEnc: "enc:k1" })]);
    await svc.pushToAgent("s1");
    expect(sendToAgent).toHaveBeenCalledWith("s1", { type: "log_drains", drains: [{ id: "d1", type: "loki", endpoint: "https://a", token: "k1" }] });
    // the effective-drain query: enabled, server-wide on this server OR app drains of apps on it (non-clustered)
    expect(findMany).toHaveBeenCalledWith({
      where: { enabled: true, OR: [{ serverId: "s1", appId: null }, { appId: { not: null }, app: { serverId: "s1", clusterId: null } }] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("forwards a legacy 'HTTP' type verbatim (the agent lowercases) with an empty token", async () => {
    const { svc, sendToAgent } = make([row({ type: "HTTP" })]);
    await svc.pushToAgent("s1");
    expect(sendToAgent).toHaveBeenCalledWith("s1", { type: "log_drains", drains: [{ id: "d1", type: "HTTP", endpoint: "https://a", token: "" }] });
  });

  it("sends an empty list when no drains remain (so the agent stops forwarding)", async () => {
    const { svc, sendToAgent } = make([]);
    await svc.pushToAgent("s1");
    expect(sendToAgent).toHaveBeenCalledWith("s1", { type: "log_drains", drains: [] });
  });

  it("keeps the exact key order {id,type,endpoint,token} and no extra keys", async () => {
    const { svc, sendToAgent } = make([row({ authTokenEnc: "enc:t" })]);
    await svc.pushToAgent("s1");
    const sent = sendToAgent.mock.calls[0][1] as { drains: unknown[] };
    expect(JSON.stringify(sent)).toBe('{"type":"log_drains","drains":[{"id":"d1","type":"http","endpoint":"https://a","token":"t"}]}');
  });

  it("a legacy row whose token cannot be decrypted is still sent with an empty token (unchanged behaviour)", async () => {
    const { svc, sendToAgent } = make([row({ authTokenEnc: "enc:BROKEN" })]);
    await svc.pushToAgent("s1");
    expect(sendToAgent).toHaveBeenCalledWith("s1", { type: "log_drains", drains: [{ id: "d1", type: "http", endpoint: "https://a", token: "" }] });
  });

  it("WITHHOLDS app, NET, filtered and options drains from an old agent (no appId/match/containers keys ever)", async () => {
    const { svc, sendToAgent } = make([
      row({ id: "plain" }),
      row({ id: "app", appId: "a1" }),
      row({ id: "net", type: "syslog", endpoint: "h:514", options: { proto: "udp" } }),
      row({ id: "filtered", containers: ["tugra_db_*"] }),
      row({ id: "opts", options: { x: 1 } }),
    ]);
    await svc.pushToAgent("s1");
    const sent = sendToAgent.mock.calls[0][1] as { type: string; drains: { id: string }[] };
    expect(sent.type).toBe("log_drains");
    expect(sent.drains.map((d) => d.id)).toEqual(["plain"]);
    expect(JSON.stringify(sent)).not.toMatch(/appId|match|containers|scope|egress|options/);
    // and the UI is told why
    for (const id of ["app", "net", "filtered", "opts"]) {
      expect(svc.deliveryFor({ id, enabled: true }, ["s1"]).delivery).toBe("agent_outdated");
    }
  });

  it("an offline agent (agentSupports false, sendToAgent false) is a harmless no-op", async () => {
    const { svc, sendToAgent } = make([row()]);
    sendToAgent.mockReturnValue(false);
    await expect(svc.pushToAgent("s1")).resolves.toBeUndefined();
  });

  it("does nothing for an unknown server", async () => {
    const { svc, sendToAgent, findMany } = make([], { server: null });
    await svc.pushToAgent("gone");
    expect(findMany).not.toHaveBeenCalled();
    expect(sendToAgent).not.toHaveBeenCalled();
  });
});

describe("LogDrainPushService: effective-drain query", () => {
  it("adds the cluster branch for a clustered server", async () => {
    const { svc, findMany } = make([], { server: { name: "n", clusterId: "c1" } });
    await svc.pushToAgent("s1");
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { serverId: "s1", appId: null },
      { appId: { not: null }, app: { serverId: "s1", clusterId: null } },
      { appId: { not: null }, app: { clusterId: "c1" } },
    ]);
  });
});

describe("LogDrainPushService: log_drains_v2", () => {
  const FIXED = [
    row({ id: "srv-http", authTokenEnc: "enc:bearer" }),
    row({ id: "srv-glob", type: "loki", containers: ["tugra_db_*"] }),
    row({ id: "srv-net", type: "syslog", endpoint: "logs.example.com:514", options: { proto: "udp", facility: 16 } }),
    row({ id: "app-http", appId: "a1", serverId: "s1", authTokenEnc: "enc:apptok" }),
    row({ id: "app-svc", appId: "a2", containers: ["web"], allowPrivate: true, type: "fluentd", endpoint: "10.0.0.5:24224", options: { proto: "tcp", tag: "t", requireAck: true } }),
  ];

  it("sends ONE signed-frame message with the full union, in a deterministic key order", async () => {
    const { svc, sendToAgent } = make(FIXED, { v2: true });
    await svc.pushToAgent("s1");
    expect(sendToAgent).toHaveBeenCalledTimes(1);
    const { msg, drains } = v2Frame(sendToAgent);
    expect(msg.type).toBe("log_drains_v2");
    expect(msg).toEqual({ type: "log_drains_v2", serverId: "s1", rev: expect.any(Number), capability: "logs", drainsJson: expect.any(String) });
    expect(drains.map((d) => d.id)).toEqual(["srv-http", "srv-glob", "srv-net", "app-http", "app-svc"]);

    // server-wide http: unguarded (no egress), no scope/match, token + host present
    expect(Object.keys(drains[0])).toEqual(["id", "type", "endpoint", "token", "host"]);
    expect(drains[0]).toMatchObject({ token: "bearer", host: "web-01" });
    // server-wide glob filter -> globs-only match
    expect(drains[1].match).toEqual({ names: [], prefixes: [], svcPrefixes: [], globs: ["tugra_db_*"] });
    // server-wide NET drain: egress any (blocks only metadata), options passed through
    expect(drains[2]).toMatchObject({ egress: "any", options: { proto: "udp", facility: 16 } });
    expect(Object.keys(drains[2])).toEqual(["id", "type", "endpoint", "token", "host", "options", "egress"]);
    // app drain: scope app + appId + resolved match (whole app) + default egress public
    expect(Object.keys(drains[3])).toEqual(["id", "type", "endpoint", "token", "scope", "appId", "match", "host", "egress"]);
    expect(drains[3]).toMatchObject({ scope: "app", appId: "a1", token: "apptok", egress: "public" });
    expect(drains[3].match).toEqual({ names: ["tugra_a1", "tugra_a1__rollout"], prefixes: ["tugra_a1-", "tugra_a1."], svcPrefixes: [], globs: [] });
    // app drain with a compose service filter + allowPrivate -> svcPrefixes + egress any
    expect(drains[4].match).toEqual({ names: [], prefixes: [], svcPrefixes: ["tugra_a2-web-"], globs: [] });
    expect(drains[4]).toMatchObject({ egress: "any", options: { proto: "tcp", tag: "t", requireAck: true } });
    // no null values anywhere; the token key is always a string
    expect(msg.drainsJson).not.toContain("null");
  });

  it("the signature verifies against canonicalLogDrains with the serverId bound", async () => {
    const signer = new HubSigningService();
    const servers = { grantedCapabilities: jest.fn().mockResolvedValue(["logs"]) } as never;
    const ws = new AgentWsServer({} as never, servers, {} as never, {} as never, signer, {} as never);
    const socket = { readyState: 1, send: jest.fn(), on: jest.fn() } as never as { send: jest.Mock };
    (ws as unknown as { state: WeakMap<object, unknown> }).state.set(socket, { nonce: "n", serverId: "s1", authed: true, features: new Set([AGENT_FEATURE_LOG_DRAINS_V2]) });
    (ws as unknown as { sockets: Map<string, unknown> }).sockets.set("s1", socket);
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ name: "web", clusterId: null }), findMany: jest.fn() },
      logDrain: { findMany: jest.fn().mockResolvedValue([row()]) },
    } as unknown as PrismaService;
    await new LogDrainPushService(prisma, crypto, ws).pushToAgent("s1");

    const sent = JSON.parse(socket.send.mock.calls.at(-1)![0]) as { serverId: string; rev: number; capability: string; drainsJson: string; sig: string };
    const pub = createPublicKey({ key: Buffer.from(signer.publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
    const check = (serverId: string) =>
      verify(null, Buffer.from(canonicalLogDrains(serverId, sent.rev, sent.drainsJson, sent.capability)), pub, Buffer.from(sent.sig, "base64"));
    expect(check("s1")).toBe(true);
    expect(check("s2")).toBe(false); // a frame captured for s1 does not verify as s2's
    expect(sent.capability).toBe("logs");
  });

  it("rev is strictly increasing across pushes", async () => {
    const { svc, sendToAgent } = make([row()], { v2: true });
    const revs: number[] = [];
    for (let i = 0; i < 5; i++) {
      await svc.pushToAgent("s1");
      revs.push(v2Frame(sendToAgent).msg.rev);
    }
    for (let i = 1; i < revs.length; i++) expect(revs[i]).toBeGreaterThan(revs[i - 1]);
    expect(revs[0]).toBeGreaterThanOrEqual(Date.now() - 5000); // clock-based, so it also increases across hub restarts
  });

  it("sends NOTHING when the `logs` capability is revoked, and says so", async () => {
    const { svc, sendToAgent } = make([row({ id: "d1" })], { v2: true, logsGranted: false });
    await svc.pushToAgent("s1");
    expect(sendToAgent).not.toHaveBeenCalled();
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s1"]).delivery).toBe("capability_revoked");
  });

  it("withholds a NET drain whose transport feature the agent lacks (agent_outdated), keeps the rest", async () => {
    const { svc, sendToAgent } = make(
      [row({ id: "plain" }), row({ id: "sys", type: "syslog", endpoint: "h.example.com:514", options: { proto: "udp" } }), row({ id: "gl", type: "gelf", endpoint: "h.example.com:12201", options: { proto: "udp" } })],
      { v2: [AGENT_FEATURE_LOG_DRAINS_V2, AGENT_FEATURE_DRAIN_GELF] },
    );
    await svc.pushToAgent("s1");
    expect(v2Frame(sendToAgent).drains.map((d) => d.id)).toEqual(["plain", "gl"]);
    expect(svc.deliveryFor({ id: "sys", enabled: true }, ["s1"]).delivery).toBe("agent_outdated");
  });

  it("fails CLOSED when an app/NET token cannot be decrypted (drain skipped, surfaced invalid), unlike a legacy row", async () => {
    const { svc, sendToAgent } = make(
      [
        row({ id: "legacy-http", authTokenEnc: "enc:BROKEN" }),
        row({ id: "app", appId: "a1", authTokenEnc: "enc:BROKEN" }),
        row({ id: "net", type: "fluentd", endpoint: "h.example.com:24224", options: { proto: "tcp" }, authTokenEnc: "enc:BROKEN" }),
      ],
      { v2: true },
    );
    await svc.pushToAgent("s1");
    const { drains } = v2Frame(sendToAgent);
    expect(drains.map((d) => d.id)).toEqual(["legacy-http"]);
    expect(drains[0].token).toBe(""); // legacy behaviour kept
    expect(svc.deliveryFor({ id: "app", enabled: true }, ["s1"]).delivery).toBe("invalid");
    expect(svc.deliveryFor({ id: "net", enabled: true }, ["s1"]).delivery).toBe("invalid");
  });

  it("an empty set is still a (signed) frame so the agent clears removed drains", async () => {
    const { svc, sendToAgent } = make([], { v2: true });
    await svc.pushToAgent("s1");
    expect(v2Frame(sendToAgent).drains).toEqual([]);
  });

  it("sanitises the host label from the server name (fallback: server id)", () => {
    expect(sanitizeHost("web 01/é", "s1")).toBe("web-01");
    expect(sanitizeHost("---", "s1")).toBe("s1");
    expect(sanitizeHost(null, "s1")).toBe("s1");
    expect(sanitizeHost("a".repeat(100), "s1")).toHaveLength(64);
  });
});

describe("LogDrainPushService: fan-out", () => {
  it("targetServerIds: the app's own server, plus every cluster member for a swarm app", async () => {
    const { svc, prisma } = make([]);
    expect(await svc.targetServerIds({ id: "a", serverId: "s9", clusterId: null })).toEqual(["s9"]);
    expect(prisma.server.findMany).not.toHaveBeenCalled();
    expect(await svc.targetServerIds({ id: "a", serverId: "s9", clusterId: "c1" })).toEqual(["s9", "s1", "s2"]);
    expect(prisma.server.findMany).toHaveBeenCalledWith({ where: { clusterId: "c1" }, select: { id: true } });
  });

  it("pushForServers pushes each unique server once and one failing server never blocks the others", async () => {
    const { svc } = make([]);
    const spy = jest.spyOn(svc, "pushToAgent").mockImplementation(async (id: string) => {
      if (id === "bad") throw new Error("boom");
    });
    await expect(svc.pushForServers(["s1", "bad", "s1", "s2"])).resolves.toBeUndefined();
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(["bad", "s1", "s2"]);
  });

  it("pushForApp pushes to every cluster member; pushForCluster to every member of the cluster", async () => {
    const { svc } = make([]);
    const spy = jest.spyOn(svc, "pushToAgent").mockResolvedValue(undefined);
    await svc.pushForApp({ id: "a", serverId: "s1", clusterId: "c1" });
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(["s1", "s2"]);
    spy.mockClear();
    await svc.pushForCluster("c1");
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(["s1", "s2"]);
  });
});

describe("LogDrainPushService: drain_status (S5, in-memory)", () => {
  async function pushed() {
    const h = make([row({ id: "d1" }), row({ id: "d2" })], { v2: true });
    await h.svc.pushToAgent("s1");
    return h;
  }

  it("stores a validated status for a pushed drain and derives delivery from it", async () => {
    const { svc } = await pushed();
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s1"]).delivery).toBe("pending"); // nothing reported yet
    svc.ingestStatus("s1", [{ id: "d1", state: "ok", sent: 12, dropped: 1, lastOkAt: 1731672000000 }, { id: "d2", state: "error", errClass: "tls", sent: 0, dropped: 4 }]);
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s1"])).toEqual({
      delivery: "ok",
      status: { sent: 12, dropped: 1, lastOkAt: new Date(1731672000000).toISOString() },
    });
    expect(svc.deliveryFor({ id: "d2", enabled: true }, ["s1"])).toEqual({ delivery: "error", status: { sent: 0, dropped: 4, errClass: "tls" } });
    expect(svc.deliveryFor({ id: "d1", enabled: false }, ["s1"])).toEqual({ delivery: "disabled", status: null });
  });

  it("ignores ids this hub never pushed to that server, and anything for a server it never pushed to", async () => {
    const { svc } = await pushed();
    svc.ingestStatus("s1", [{ id: "other-servers-drain", state: "ok", sent: 1, dropped: 0 }]);
    expect(svc.deliveryFor({ id: "other-servers-drain", enabled: true }, ["s1"]).delivery).toBe("pending");
    svc.ingestStatus("s7", [{ id: "d1", state: "ok", sent: 1, dropped: 0 }]); // never pushed to s7
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s7"]).delivery).not.toBe("ok");
  });

  it("validates enums, clamps numbers, drops malformed entries and caps the entry count", async () => {
    const { svc } = await pushed();
    svc.ingestStatus("s1", [
      { id: "d1", state: "exploding", sent: 1, dropped: 0 }, // bad state -> dropped
      { id: "d2", state: "error", errClass: "<script>", sent: -5, dropped: 1e308 * 10 }, // bad errClass ignored, numbers clamped
      null,
      "str",
      { id: "x".repeat(41), state: "ok", sent: 1, dropped: 0 },
    ]);
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s1"]).delivery).toBe("pending");
    expect(svc.deliveryFor({ id: "d2", enabled: true }, ["s1"])).toEqual({ delivery: "error", status: { sent: 0, dropped: 0 } });
    svc.ingestStatus("s1", "not-an-array" as never); // never throws
    svc.ingestStatus("s1", new Array(500).fill({ id: "d1", state: "ok", sent: 1, dropped: 0 }));
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s1"]).delivery).toBe("ok");
  });

  it("status older than 120 s reads as pending; an offline agent reads as offline", async () => {
    const { svc, agentWs } = await pushed();
    svc.ingestStatus("s1", [{ id: "d1", state: "ok", sent: 1, dropped: 0 }]);
    const now = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(now + 121_000);
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s1"]).delivery).toBe("pending");
    spy.mockRestore();
    (agentWs.isOnline as jest.Mock).mockReturnValue(false);
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s1"]).delivery).toBe("offline");
  });

  it("an app drain's delivery is the worst-of over its target servers (invalid > error > ... > ok)", async () => {
    const { svc, agentWs } = await pushed();
    await svc.pushToAgent("s1");
    svc.ingestStatus("s1", [{ id: "d1", state: "ok", sent: 5, dropped: 0 }]);
    // s2 was never pushed -> pending; s3 offline
    (agentWs.isOnline as jest.Mock).mockImplementation((id: string) => id !== "s3");
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s1"]).delivery).toBe("ok");
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s1", "s2"]).delivery).toBe("pending");
    expect(svc.deliveryFor({ id: "d1", enabled: true }, ["s1", "s2", "s3"]).delivery).toBe("offline");
    expect(svc.deliveryFor({ id: "d1", enabled: true }, [])).toMatchObject({ delivery: "offline" });
  });
});

describe("LogDrainPushService: per-server push serialization", () => {
  it("overlapping pushes never interleave: the newer snapshot is read after the mutation and is signed with the higher rev", async () => {
    const { svc, findMany, sendToAgent, agentWs } = make([], { v2: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // push 1 reads the OLD set, then stalls on the capability check; the mutation lands; push 2 is requested.
    (agentWs.isCapabilityGranted as jest.Mock).mockImplementationOnce(async () => {
      await gate;
      return true;
    });
    findMany.mockResolvedValueOnce([row({ id: "old" })]).mockResolvedValue([row({ id: "new" })]);
    const p1 = svc.pushToAgent("s1");
    await new Promise((r) => setImmediate(r));
    const p2 = svc.pushToAgent("s1");
    const p3 = svc.pushToAgent("s1"); // coalesces with p2
    release();
    await Promise.all([p1, p2, p3]);
    const frames = sendToAgent.mock.calls.map((c) => c[1] as { rev: number; drainsJson: string });
    expect(frames).toHaveLength(2);
    expect(frames[1].rev).toBeGreaterThan(frames[0].rev);
    expect(JSON.parse(frames[0].drainsJson)[0].id).toBe("old");
    expect(JSON.parse(frames[1].drainsJson)[0].id).toBe("new");
    expect(findMany).toHaveBeenCalledTimes(2); // p2 + p3 became ONE follow-up read
  });

  it("different servers push independently, and a failed push does not wedge the server", async () => {
    const { svc, findMany, sendToAgent } = make([row()], { v2: true });
    findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(svc.pushToAgent("s1")).rejects.toThrow("db down");
    await Promise.all([svc.pushToAgent("s1"), svc.pushToAgent("s2")]);
    expect(sendToAgent).toHaveBeenCalledTimes(2);
  });
});
