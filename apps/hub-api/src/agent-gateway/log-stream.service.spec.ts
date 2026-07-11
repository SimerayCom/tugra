import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { LogStreamService, type LogStreamEvent } from "./log-stream.service";
import type { LogListener } from "./agent-ws.server";

const flush = () => new Promise((r) => setImmediate(r));

function makeAgentWs(overrides: Partial<Record<string, jest.Mock>> = {}) {
  let captured: LogListener | undefined;
  const agentWs = {
    startLogStream: jest.fn().mockImplementation((_s: string, _p: unknown, l: LogListener) => {
      captured = l;
      return Promise.resolve("stream-1");
    }),
    stopLogStream: jest.fn(),
    ...overrides,
  };
  return { agentWs, listener: () => captured };
}

describe("LogStreamService", () => {
  it("relays chunks, forwards start params, and stops the agent stream on unsubscribe", async () => {
    const { agentWs, listener } = makeAgentWs();
    const svc = new LogStreamService(agentWs as never);
    const events: LogStreamEvent[] = [];
    const sub = svc.stream("s1", "tugra_app1", { tail: 150, follow: true }).subscribe((e) => events.push(e));
    await flush();
    expect(agentWs.startLogStream).toHaveBeenCalledWith(
      "s1",
      { target: "tugra_app1", tail: 150, follow: true },
      expect.anything(),
    );
    listener()!.onChunk("hello\n");
    listener()!.onChunk("world\n");
    expect(events).toEqual([{ chunk: "hello\n" }, { chunk: "world\n" }]);
    sub.unsubscribe();
    expect(agentWs.stopLogStream).toHaveBeenCalledWith("s1", "stream-1");
  });

  it("completes (and tears down) when the agent stream exits", async () => {
    const { agentWs, listener } = makeAgentWs();
    const svc = new LogStreamService(agentWs as never);
    const events: LogStreamEvent[] = [];
    let completed = false;
    svc.stream("s1", "c", { tail: 1, follow: true }).subscribe({ next: (e) => events.push(e), complete: () => (completed = true) });
    await flush();
    listener()!.onExit(0);
    expect(events).toContainEqual({ exitCode: 0 });
    expect(completed).toBe(true);
    expect(agentWs.stopLogStream).toHaveBeenCalledWith("s1", "stream-1"); // teardown ran
  });

  it("errors the observable when the agent refuses (offline / capability not granted)", async () => {
    const { agentWs } = makeAgentWs({
      startLogStream: jest.fn().mockRejectedValue(new ForbiddenException("no logs cap")),
    });
    const svc = new LogStreamService(agentWs as never);
    let err: unknown;
    svc.stream("s1", "c", { tail: 1, follow: true }).subscribe({ error: (e) => (err = e) });
    await flush();
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it("caps concurrent streams per server (isolated per server)", async () => {
    // A startLogStream that never resolves keeps every stream 'active'.
    const { agentWs } = makeAgentWs({ startLogStream: jest.fn().mockReturnValue(new Promise<string>(() => {})) });
    const svc = new LogStreamService(agentWs as never);
    const subs = Array.from({ length: 5 }, () => svc.stream("s1", "c", { tail: 1, follow: true }).subscribe({ error() {} }));
    let capped: unknown;
    svc.stream("s1", "c", { tail: 1, follow: true }).subscribe({ error: (e) => (capped = e) });
    expect(capped).toBeInstanceOf(ServiceUnavailableException);
    // a different server is unaffected
    let otherOk = true;
    svc.stream("s2", "c", { tail: 1, follow: true }).subscribe({ error: () => (otherOk = false) }).unsubscribe();
    expect(otherOk).toBe(true);
    subs.forEach((s) => s.unsubscribe()); // clear the (unref'd) duration timers
  });
});
