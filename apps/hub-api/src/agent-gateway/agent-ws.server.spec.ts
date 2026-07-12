import { AgentWsServer } from "./agent-ws.server";

/**
 * Unit-level coverage of command/log/result correlation. The full agent
 * round-trip (real WebSocket) is exercised by the e2e suites.
 */
const hubSign = { sign: jest.fn().mockReturnValue("SIG"), publicKeySpkiBase64: "HUBKEY" } as any;

// sendCommand awaits the hub-side capability grant check (a DB read) before it signs + sends,
// so flush the microtask/macrotask queue before asserting on the outbound message.
const flush = () => new Promise((r) => setImmediate(r));

const ALL_CAPS = ["deploy", "database", "backup", "cleanup", "bulk", "terminal", "schedule", "patch", "logs"];

function harness() {
  const servers = { markOffline: jest.fn(), grantedCapabilities: jest.fn().mockResolvedValue(ALL_CAPS), touch: jest.fn() } as any;
  const metrics = { ingest: jest.fn() } as any;
  const containerMetrics = { ingest: jest.fn() } as any;
  const server = new AgentWsServer({} as any, servers, metrics, containerMetrics, hubSign);
  const socket = { readyState: 1, send: jest.fn(), on: jest.fn(), close: jest.fn() } as any; // 1 === WebSocket.OPEN
  (server as any).state.set(socket, { nonce: "n", serverId: "s1", authed: true });
  (server as any).sockets.set("s1", socket);
  const lastSent = () => JSON.parse(socket.send.mock.calls.at(-1)![0]);
  const deliver = (msg: object) => (server as any).onMessage(socket, JSON.stringify(msg));
  return { server, socket, lastSent, deliver, metrics, containerMetrics };
}

describe("AgentWsServer command streaming", () => {
  it("routes command_log chunks to the sendCommand onChunk callback", async () => {
    const { server, lastSent, deliver } = harness();
    const chunks: string[] = [];
    const p = server.sendCommand("s1", "echo hi", "deploy", 5000, (c) => chunks.push(c));
    await flush();
    const sent = lastSent();
    expect(sent.type).toBe("command");
    expect(sent.capability).toBe("deploy");
    expect(sent.timeoutMs).toBe(5000); // per-command timeout sent to the agent
    const reqId = sent.reqId;

    await deliver({ type: "command_log", reqId, chunk: "building…\n" });
    await deliver({ type: "command_log", reqId, chunk: "done\n" });
    expect(chunks).toEqual(["building…\n", "done\n"]);

    await deliver({ type: "command_result", reqId, exitCode: 0, output: "ok" });
    await expect(p).resolves.toEqual({ exitCode: 0, output: "ok" });
  });

  it("refuses to sign a command for a capability the server hasn't granted", async () => {
    const servers = { markOffline: jest.fn(), grantedCapabilities: jest.fn().mockResolvedValue(["deploy", "database"]) } as any;
    const server = new AgentWsServer({} as any, servers, {} as any, {} as any, hubSign);
    const socket = { readyState: 1, send: jest.fn(), on: jest.fn() } as any;
    (server as any).sockets.set("s1", socket);
    // "terminal" is not in the granted set → rejected BEFORE any signing/send
    await expect(server.sendCommand("s1", "sh", "terminal", 5000)).rejects.toThrow(/not granted/);
    expect(socket.send).not.toHaveBeenCalled();
    // a granted capability goes through
    server.sendCommand("s1", "deploy.sh", "deploy", 5000).catch(() => undefined);
    await flush();
    expect(socket.send).toHaveBeenCalled();
  });

  it("fail-safe: an empty grant denies every capability (never means 'all')", async () => {
    const servers = { markOffline: jest.fn(), grantedCapabilities: jest.fn().mockResolvedValue([]) } as any;
    const server = new AgentWsServer({} as any, servers, {} as any, {} as any, hubSign);
    const socket = { readyState: 1, send: jest.fn(), on: jest.fn() } as any;
    (server as any).sockets.set("s1", socket);
    await expect(server.sendCommand("s1", "deploy.sh", "deploy", 5000)).rejects.toThrow(/not granted/);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("swallows command_log for an unknown reqId", async () => {
    const { deliver } = harness();
    await expect(deliver({ type: "command_log", reqId: "bogus", chunk: "x" })).resolves.toBeUndefined();
  });

  it("stops delivering chunks after the result arrives (listener cleaned up)", async () => {
    const { server, lastSent, deliver } = harness();
    const chunks: string[] = [];
    const p = server.sendCommand("s1", "echo", "deploy", 5000, (c) => chunks.push(c));
    await flush();
    const reqId = lastSent().reqId;
    await deliver({ type: "command_result", reqId, exitCode: 0, output: "ok" });
    await p;
    await deliver({ type: "command_log", reqId, chunk: "late" });
    expect(chunks).toEqual([]);
  });

  it("rejects pending commands when the agent disconnects mid-stream", async () => {
    const { server } = harness();
    const p = server.sendCommand("s1", "sleep 999", "deploy", 300_000, () => undefined);
    await flush();
    (server as any).rejectPendingFor("s1");
    await expect(p).rejects.toThrow(/disconnected/);
    expect((server as any).chunkListeners.size).toBe(0);
    expect((server as any).pending.size).toBe(0);
  });
});

describe("AgentWsServer terminal relay", () => {
  it("forwards term_output/term_exit to the terminal delegate", async () => {
    const { server, deliver } = harness();
    const delegate = { handleAgentTerminal: jest.fn(), handleServerDisconnect: jest.fn() };
    server.setTerminalDelegate(delegate);
    const out = { type: "term_output", sessionId: "x", data: "aGk=" };
    await deliver(out);
    expect(delegate.handleAgentTerminal).toHaveBeenCalledWith("s1", out);
    const exit = { type: "term_exit", sessionId: "x", exitCode: 0 };
    await deliver(exit);
    expect(delegate.handleAgentTerminal).toHaveBeenCalledWith("s1", exit);
  });

  it("signs outbound command messages with the hub key", async () => {
    const { server, lastSent } = harness();
    // never resolved here → guard the unhandled rejection AND clear the pending
    // timeout timer so it can't fire after the suite (this crashed CI).
    server.sendCommand("s1", "echo hi", "deploy", 5000).catch(() => undefined);
    await flush();
    const sent = lastSent();
    expect(sent.type).toBe("command");
    expect(sent.sig).toBe("SIG"); // signOutbound attached the hub signature
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).rejectPendingFor("s1");
  });

  it("sendToAgent returns true when online, false when offline", () => {
    const { server } = harness();
    expect(server.sendToAgent("s1", { type: "term_close", sessionId: "x" })).toBe(true);
    expect(server.sendToAgent("ghost", { type: "term_close", sessionId: "x" })).toBe(false);
  });

  it("isOnline reflects connected agents", () => {
    const { server } = harness();
    expect(server.isOnline("s1")).toBe(true);
    expect(server.isOnline("ghost")).toBe(false);
  });
});

describe("AgentWsServer live container-log streams", () => {
  it("signs log_start (canonicalLogStart) and sends it after the capability check", async () => {
    const { server, lastSent } = harness();
    const listener = { onChunk: jest.fn(), onExit: jest.fn() };
    const streamId = await server.startLogStream("s1", { target: "tugra_app1", tail: 200, follow: true, since: "1h", search: "err" }, listener);
    const sent = lastSent();
    expect(sent.type).toBe("log_start");
    expect(sent.streamId).toBe(streamId);
    expect(sent.target).toBe("tugra_app1");
    expect(sent.tail).toBe(200);
    expect(sent.follow).toBe(true);
    expect(sent.since).toBe("1h"); // threaded into the outbound message
    expect(sent.search).toBe("err");
    expect(sent.capability).toBe("logs");
    expect(sent.sig).toBe("SIG"); // signOutbound stamped the log_start signature
  });

  it("defaults omitted since/search to '' in the outbound message", async () => {
    const { server, lastSent } = harness();
    await server.startLogStream("s1", { target: "c", tail: 50, follow: false }, { onChunk: jest.fn(), onExit: jest.fn() });
    const sent = lastSent();
    expect(sent.since).toBe("");
    expect(sent.search).toBe("");
  });

  it("refuses to start a log stream when the 'logs' capability is not granted", async () => {
    // A server whose granted set excludes "logs".
    const servers = { markOffline: jest.fn(), grantedCapabilities: jest.fn().mockResolvedValue(["deploy"]) } as any;
    const s2 = new AgentWsServer({} as any, servers, { ingest: jest.fn() } as any, { ingest: jest.fn() } as any, hubSign);
    const socket = { readyState: 1, send: jest.fn(), on: jest.fn(), close: jest.fn() } as any;
    (s2 as any).sockets.set("s1", socket);
    await expect(
      s2.startLogStream("s1", { target: "c", tail: 1, follow: true }, { onChunk: jest.fn(), onExit: jest.fn() }),
    ).rejects.toThrow(/logs/);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("routes log_chunk/log_exit to the matching streamId listener (isolation)", async () => {
    const { server, deliver } = harness();
    const a = { onChunk: jest.fn(), onExit: jest.fn() };
    const b = { onChunk: jest.fn(), onExit: jest.fn() };
    const idA = await server.startLogStream("s1", { target: "a", tail: 1, follow: true }, a);
    const idB = await server.startLogStream("s1", { target: "b", tail: 1, follow: true }, b);
    await deliver({ type: "log_chunk", streamId: idA, chunk: "for-a" });
    expect(a.onChunk).toHaveBeenCalledWith("for-a");
    expect(b.onChunk).not.toHaveBeenCalled();
    await deliver({ type: "log_exit", streamId: idB, exitCode: 0 });
    expect(b.onExit).toHaveBeenCalledWith(0);
    expect(a.onExit).not.toHaveBeenCalled();
  });

  it("ends live log streams for a server on disconnect (onExit -1) and drops the listener", async () => {
    const { server } = harness();
    const listener = { onChunk: jest.fn(), onExit: jest.fn() };
    const id = await server.startLogStream("s1", { target: "c", tail: 1, follow: true }, listener);
    (server as any).failLogStreamsFor("s1");
    expect(listener.onExit).toHaveBeenCalledWith(-1);
    expect((server as any).logListeners.has(id)).toBe(false);
  });

  it("ends the stream at once if the agent drops during the capability await (no 30-min listener leak)", async () => {
    let resolveCaps!: (v: string[]) => void;
    const servers = { markOffline: jest.fn(), grantedCapabilities: jest.fn(() => new Promise<string[]>((r) => (resolveCaps = r))) } as any;
    const s = new AgentWsServer({} as any, servers, { ingest: jest.fn() } as any, { ingest: jest.fn() } as any, hubSign);
    const socket = { readyState: 1, send: jest.fn(), on: jest.fn(), close: jest.fn() } as any;
    (s as any).sockets.set("s1", socket);
    const listener = { onChunk: jest.fn(), onExit: jest.fn() };
    const p = s.startLogStream("s1", { target: "c", tail: 1, follow: true }, listener);
    (s as any).sockets.delete("s1"); // agent flaps offline mid-await
    resolveCaps(["logs"]);
    await p;
    expect(socket.send).not.toHaveBeenCalled(); // delivery failed
    expect(listener.onExit).toHaveBeenCalledWith(-1); // stream ended immediately, not after 30 min
    expect((s as any).logListeners.size).toBe(0);
  });
});

describe("AgentWsServer container metrics ingest", () => {
  const batch = {
    type: "container_metrics",
    ts: 1_700_000_000_000,
    samples: [{ id: "abc", name: "web", cpu: 1, memUsed: 1, memTotal: 2, memPct: 50, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0 }],
  };

  it("ingests a container_metrics batch from an authed agent", async () => {
    const { deliver, containerMetrics } = harness();
    await deliver(batch);
    expect(containerMetrics.ingest).toHaveBeenCalledWith("s1", expect.objectContaining({ type: "container_metrics", ts: batch.ts }));
  });

  it("rejects container_metrics from an unauthed socket (never ingests)", async () => {
    const { server, socket, containerMetrics } = harness();
    (server as any).state.set(socket, { nonce: "n", authed: false }); // no serverId, not authed
    await (server as any).onMessage(socket, JSON.stringify(batch));
    expect(containerMetrics.ingest).not.toHaveBeenCalled();
  });
});

describe("AgentWsServer capability delivery (agent fail-closed)", () => {
  it("seeds the agent's allowlist by putting the granted set in the enrolled payload", async () => {
    const servers = {
      markOffline: jest.fn(),
      enroll: jest.fn().mockResolvedValue({ serverId: "s1", seal: "SEAL" }),
      grantedCapabilities: jest.fn().mockResolvedValue(["deploy", "backup"]),
    } as any;
    const server = new AgentWsServer({} as any, servers, {} as any, {} as any, hubSign);
    const socket = { readyState: 1, send: jest.fn(), on: jest.fn() } as any;
    (server as any).state.set(socket, { nonce: "n", authed: false });
    await (server as any).onMessage(socket, JSON.stringify({ type: "enroll", token: "t", publicKey: "pk", agentVersion: "1", hostname: "h" }));
    const sent = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(sent.type).toBe("enrolled");
    expect(sent.capabilities).toEqual(["deploy", "backup"]);
  });

  it("registers a pusher that live-sends the granted set as a 'capabilities' message", () => {
    const setCapabilityPusher = jest.fn();
    const servers = { markOffline: jest.fn(), setCapabilityPusher } as any;
    const fakeHttp = { on: jest.fn() };
    const httpAdapterHost = { httpAdapter: { getHttpServer: () => fakeHttp } } as any;
    const server = new AgentWsServer(httpAdapterHost, servers, {} as any, {} as any, hubSign);
    server.onApplicationBootstrap();
    expect(setCapabilityPusher).toHaveBeenCalledTimes(1);
    // The registered pusher forwards to the connected agent as an unsigned "capabilities" message.
    const socket = { readyState: 1, send: jest.fn() } as any;
    (server as any).sockets.set("s1", socket);
    (setCapabilityPusher.mock.calls[0][0] as (id: string, caps: string[]) => void)("s1", ["deploy"]);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: "capabilities", capabilities: ["deploy"] });
    void server.onModuleDestroy(); // close the WS server created by bootstrap (no lingering handle)
  });
});
