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

  it("exposes the reqId via onStart and cancels it with a signed command_cancel", async () => {
    const { server, socket, lastSent, deliver } = harness();
    let startedReqId = "";
    const p = server.sendCommand("s1", "sleep 99", "deploy", 5000, undefined, (reqId) => { startedReqId = reqId; });
    await flush();
    const sent = lastSent();
    expect(sent.type).toBe("command");
    expect(startedReqId).toBe(sent.reqId); // onStart got the same reqId that went on the wire

    server.cancelCommand("s1", startedReqId);
    const cancelMsg = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(cancelMsg.type).toBe("command_cancel");
    expect(cancelMsg.reqId).toBe(startedReqId);
    expect(cancelMsg.sig).toBe("SIG"); // signOutbound stamped canonicalCommandCancel

    // The agent kills the process group → command_result (non-zero) → the original promise resolves.
    await deliver({ type: "command_result", reqId: startedReqId, exitCode: 137, output: "killed" });
    await expect(p).resolves.toEqual({ exitCode: 137, output: "killed" });
  });

  it("cancelCommand is a no-op when the agent is offline (no throw)", () => {
    const { server } = harness();
    expect(() => server.cancelCommand("nope", "r1")).not.toThrow();
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

  describe("sendAgentUpdate", () => {
    it("signs + sends an agent_update when the deploy capability is granted", async () => {
      const { server, lastSent } = harness();
      const ok = await server.sendAgentUpdate("s1", "0.2.0", "ghcr.io/simeraycom/tugra-agent:0.2.0", "abc123");
      expect(ok).toBe(true);
      const sent = lastSent();
      expect(sent.type).toBe("agent_update");
      expect(sent).toMatchObject({
        targetVersion: "0.2.0",
        image: "ghcr.io/simeraycom/tugra-agent:0.2.0",
        sha256: "abc123",
        capability: "deploy",
        sig: "SIG", // signOutbound stamped the hub signature over canonicalAgentUpdate
      });
      expect(typeof sent.reqId).toBe("string");
    });

    it("returns false (no send) when the deploy capability is not granted (fail-closed)", async () => {
      const servers = { markOffline: jest.fn(), grantedCapabilities: jest.fn().mockResolvedValue(["logs"]) } as any;
      const server = new AgentWsServer({} as any, servers, {} as any, {} as any, hubSign);
      const socket = { readyState: 1, send: jest.fn() } as any;
      (server as any).sockets.set("s1", socket);
      expect(await server.sendAgentUpdate("s1", "0.2.0", "img", "sha")).toBe(false);
      expect(socket.send).not.toHaveBeenCalled();
    });

    it("returns false when the agent is offline", async () => {
      const { server } = harness();
      expect(await server.sendAgentUpdate("ghost", "0.2.0", "img", "sha")).toBe(false);
    });
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

describe("AgentWsServer file ops", () => {
  // A server whose granted set includes "files" (default-off capability).
  function fsHarness(caps: string[] = [...ALL_CAPS, "files"]) {
    const servers = { markOffline: jest.fn(), grantedCapabilities: jest.fn().mockResolvedValue(caps) } as any;
    const server = new AgentWsServer({} as any, servers, { ingest: jest.fn() } as any, { ingest: jest.fn() } as any, hubSign);
    const socket = { readyState: 1, send: jest.fn(), on: jest.fn(), close: jest.fn() } as any;
    (server as any).state.set(socket, { nonce: "n", serverId: "s1", authed: true });
    (server as any).sockets.set("s1", socket);
    const lastSent = () => JSON.parse(socket.send.mock.calls.at(-1)![0]);
    const deliver = (msg: object) => (server as any).onMessage(socket, JSON.stringify(msg));
    return { server, socket, lastSent, deliver };
  }

  it("signs fs_req (canonicalFs) and resolves on fs_result", async () => {
    const { server, lastSent, deliver } = fsHarness();
    const p = server.sendFsReq("s1", "list", "tugra_appv_x_data", "sub/dir");
    await flush();
    const sent = lastSent();
    expect(sent.type).toBe("fs_req");
    expect(sent.op).toBe("list");
    expect(sent.volume).toBe("tugra_appv_x_data");
    expect(sent.path).toBe("sub/dir");
    expect(sent.capability).toBe("files");
    expect(sent.sig).toBe("SIG"); // signOutbound stamped canonicalFs
    await deliver({ type: "fs_result", reqId: sent.reqId, ok: true, entries: [{ name: "a", type: "file", size: 1, mode: "rw-r--r--", mtime: 2 }], truncated: true });
    await expect(p).resolves.toEqual({ entries: [{ name: "a", type: "file", size: 1, mode: "rw-r--r--", mtime: 2 }], truncated: true });
  });

  it("rejects when the fs_result reports an error", async () => {
    const { server, lastSent, deliver } = fsHarness();
    const p = server.sendFsReq("s1", "list", "tugra_appv_x_data", "");
    await flush();
    await deliver({ type: "fs_result", reqId: lastSent().reqId, ok: false, error: "not a directory" });
    await expect(p).rejects.toThrow(/not a directory/);
  });

  it("refuses to sign fs_req when 'files' is not granted (fail-closed, default-off)", async () => {
    const { server, socket } = fsHarness(ALL_CAPS); // ALL_CAPS deliberately excludes "files"
    await expect(server.sendFsReq("s1", "list", "tugra_appv_x_data", "")).rejects.toThrow(/not granted/);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("rejects when the agent is offline", async () => {
    const { server } = fsHarness();
    await expect(server.sendFsReq("ghost", "list", "v", "")).rejects.toThrow(/offline/);
  });

  it("ignores an fs_result whose serverId doesn't match the pending request (cross-agent isolation)", async () => {
    const { server, lastSent, deliver } = fsHarness();
    const p = server.sendFsReq("s1", "list", "v", "");
    await flush();
    const reqId = lastSent().reqId;
    // A reply arriving on a DIFFERENT authed socket must not resolve s1's pending op.
    const other = { readyState: 1, send: jest.fn(), on: jest.fn(), close: jest.fn() } as any;
    (server as any).state.set(other, { nonce: "n", serverId: "s2", authed: true });
    await (server as any).onMessage(other, JSON.stringify({ type: "fs_result", reqId, ok: true, entries: [] }));
    expect((server as any).fsPending.has(reqId)).toBe(true); // still pending — foreign reply ignored
    // the legitimate reply resolves it
    await deliver({ type: "fs_result", reqId, ok: true, entries: [], truncated: false });
    await expect(p).resolves.toEqual({ entries: [], truncated: false });
  });

  it("rejects a pending fs op when the agent disconnects", async () => {
    const { server } = fsHarness();
    const p = server.sendFsReq("s1", "list", "v", "");
    await flush();
    (server as any).rejectPendingFor("s1");
    await expect(p).rejects.toThrow(/disconnected/);
    expect((server as any).fsPending.size).toBe(0);
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

describe("AgentWsServer keepalive sweep (half-open detection)", () => {
  const makeServer = () =>
    new AgentWsServer({} as any, { markOffline: jest.fn(), grantedCapabilities: jest.fn(), touch: jest.fn() } as any, {} as any, {} as any, hubSign);

  it("terminates a socket that missed its pong (dead/half-open) and pings a live one", () => {
    const server = makeServer();
    const dead = { terminate: jest.fn(), ping: jest.fn() } as any;
    const live = { terminate: jest.fn(), ping: jest.fn() } as any;
    (server as any).state.set(dead, { nonce: "n", authed: true, serverId: "d", isAlive: false });
    (server as any).state.set(live, { nonce: "n", authed: true, serverId: "l", isAlive: true });
    (server as any).wss = { clients: new Set([dead, live]) };
    (server as any).keepaliveSweep();
    expect(dead.terminate).toHaveBeenCalled();
    expect(dead.ping).not.toHaveBeenCalled();
    expect(live.terminate).not.toHaveBeenCalled();
    expect(live.ping).toHaveBeenCalled();
    expect((server as any).state.get(live).isAlive).toBe(false); // now pending the next pong
  });

  it("a socket whose pong arrived between sweeps survives (never terminated)", () => {
    const server = makeServer();
    const s = { terminate: jest.fn(), ping: jest.fn() } as any;
    (server as any).state.set(s, { nonce: "n", authed: true, serverId: "x", isAlive: true });
    (server as any).wss = { clients: new Set([s]) };
    (server as any).keepaliveSweep(); // isAlive→false, ping sent
    (server as any).state.get(s).isAlive = true; // pong handler would set this
    (server as any).keepaliveSweep(); // still alive → ping again, no terminate
    expect(s.terminate).not.toHaveBeenCalled();
    expect(s.ping).toHaveBeenCalledTimes(2);
  });
});

describe("AgentWsServer auth-rejection signaling (no agent self-brick)", () => {
  const mockSocket = () => ({ readyState: 1, send: jest.fn(), on: jest.fn(), close: jest.fn(), terminate: jest.fn() }) as any;
  const serverWith = (authResult: "ok" | "unknown" | "bad_signature") =>
    new AgentWsServer(
      {} as any,
      { authenticate: jest.fn().mockResolvedValue(authResult), grantedCapabilities: jest.fn().mockResolvedValue([]), markOffline: jest.fn() } as any,
      {} as any,
      {} as any,
      hubSign,
    );
  const drive = async (authResult: "unknown" | "bad_signature") => {
    const server = serverWith(authResult);
    const sock = mockSocket();
    (server as any).onConnection(sock, { socket: { remoteAddress: "1.2.3.4" }, headers: {} });
    await (server as any).onMessage(sock, JSON.stringify({ type: "auth", serverId: "s1", signature: "sig" }));
    // onConnection sends the challenge first; the rejection is the last frame written.
    const sent = String(sock.send.mock.calls.at(-1)?.[0] ?? "");
    return { sent, sock };
  };

  it("sends code 'reenroll' ONLY when the identity is unknown (server gone / never enrolled)", async () => {
    const { sent, sock } = await drive("unknown");
    expect(sent).toContain('"type":"error"');
    expect(sent).toContain('"code":"reenroll"');
    expect(sock.close).toHaveBeenCalled();
  });

  it("a bad signature on a KNOWN server is a generic rejection with NO reenroll code (agent keeps identity)", async () => {
    const { sent, sock } = await drive("bad_signature");
    expect(sent).toContain('"type":"error"');
    expect(sent).not.toContain("reenroll");
    expect(sock.close).toHaveBeenCalled();
  });
});

describe("AgentWsServer pre-auth handshake deadline", () => {
  const mockSocket = () => ({ readyState: 1, send: jest.fn(), on: jest.fn(), close: jest.fn(), terminate: jest.fn() }) as any;
  const makeServer = (authenticate = jest.fn().mockResolvedValue("ok")) =>
    new AgentWsServer({} as any, { authenticate, grantedCapabilities: jest.fn().mockResolvedValue([]), markOffline: jest.fn() } as any, {} as any, {} as any, hubSign);

  it("closes a socket still unauthenticated when the deadline fires (1008)", () => {
    const server = makeServer();
    const sock = mockSocket();
    (server as any).state.set(sock, { nonce: "n", authed: false, isAlive: true });
    (server as any).closeIfUnauthed(sock);
    expect(sock.close).toHaveBeenCalledWith(1008, "auth timeout");
  });

  it("leaves an already-authenticated socket alone at the deadline", () => {
    const server = makeServer();
    const sock = mockSocket();
    (server as any).state.set(sock, { nonce: "n", authed: true, serverId: "s1", isAlive: true });
    (server as any).closeIfUnauthed(sock);
    expect(sock.close).not.toHaveBeenCalled();
  });

  it("schedules the close on connect, and a successful auth clears it so it never fires", async () => {
    jest.useFakeTimers();
    try {
      const server = makeServer();
      // never authenticates → timer fires → closed
      const dead = mockSocket();
      (server as any).onConnection(dead, { socket: { remoteAddress: "1.2.3.4" }, headers: {} });
      jest.advanceTimersByTime(10_000);
      expect(dead.close).toHaveBeenCalledWith(1008, "auth timeout");

      // authenticates before the deadline → timer cleared → never closed
      const live = mockSocket();
      (server as any).onConnection(live, { socket: { remoteAddress: "1.2.3.4" }, headers: {} });
      await (server as any).onMessage(live, JSON.stringify({ type: "auth", serverId: "s1", signature: "sig", agentVersion: "1" }));
      jest.advanceTimersByTime(10_000);
      expect(live.close).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
