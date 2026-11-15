import { PartTransferService } from "./part-transfer.service";

const MOVE_ID = "ckmoveabcdefghijklmnopqrs";
const SHA = "d".repeat(64);
const req = { moveId: MOVE_ID, idx: 1, part: 4, size: 1000, sha256: SHA, srcServerId: "s1", dstServerId: "s2" };
const SRC_PATH = "/api/v1/agent-vx/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=SRCSIGSRCSIGSRCSIGSRCSIG";
const DST_PATH = "/api/v1/agent-vx/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=DSTSIGDSTSIGDSTSIGDSTSIG";

function make(opts: { busy?: boolean; done?: Promise<{ bytes: number; sha256: string }>; onSend?: (server: string, script: string) => Promise<{ exitCode: number; output: string }> } = {}) {
  let n = 0;
  const cancelCommand = jest.fn().mockReturnValue(true);
  const sendCommand = jest.fn((server: string, script: string, _cap: string, _t: number, _chunk: unknown, onStart?: (id: string) => void) => {
    onStart?.(`req-${++n}-${server}`);
    if (opts.onSend) return opts.onSend(server, script);
    return Promise.resolve({ exitCode: 0, output: script.includes("curl -fsS --no-buffer") ? "TUGRA_VX_RECV_OK\n" : "TUGRA_VX_SEND_OK\n" });
  });
  const cancel = jest.fn();
  const register = jest.fn().mockReturnValue(
    opts.busy ? { busy: true } : { busy: false, id: "AAAAAAAAAAAAAAAAAAAAAAAA", srcPath: SRC_PATH, dstPath: DST_PATH, done: opts.done ?? Promise.resolve({ bytes: 1000, sha256: SHA }), cancel },
  );
  const svc = new PartTransferService({ sendCommand, cancelCommand } as never, { register } as never);
  return { svc, sendCommand, cancelCommand, register, cancel };
}

describe("PartTransferService", () => {
  it("runs the receive on the TARGET and the send on the SOURCE concurrently (backup capability) with their own signed path", async () => {
    const t = make();
    const r = await t.svc.transfer(req);
    expect(r).toEqual({ ok: true, bytes: 1000 });
    expect(t.register).toHaveBeenCalledWith({ moveId: MOVE_ID, volIdx: 1, part: 4, size: 1000, sha256: SHA, srcServerId: "s1", dstServerId: "s2" });
    const calls = Object.fromEntries(t.sendCommand.mock.calls.map((c) => [c[0], c]));
    expect(calls.s2[1]).toContain("curl -fsS --no-buffer");
    expect(calls.s2[1]).toContain("DSTSIG"); // the target gets the dst claim...
    expect(calls.s2[1]).not.toContain("SRCSIG");
    expect(calls.s1[1]).toContain("-T");
    expect(calls.s1[1]).toContain("SRCSIG"); // ...the source the src claim
    expect(calls.s1[1]).not.toContain("DSTSIG");
    expect(t.sendCommand.mock.calls.every((c) => c[2] === "backup" && c[3] === 900_000)).toBe(true);
  });

  it("a busy relay is reported as busy (no command is sent)", async () => {
    const t = make({ busy: true });
    expect(await t.svc.transfer(req)).toMatchObject({ ok: false, busy: true });
    expect(t.sendCommand).not.toHaveBeenCalled();
  });

  it("a receive failure (sha 66) cancels the source command and the relay; the result names both exit codes", async () => {
    const pending: Record<string, (v: { exitCode: number; output: string }) => void> = {};
    const t = make({ onSend: (server) => (server === "s2" ? Promise.resolve({ exitCode: 66, output: "sha mismatch\n" }) : new Promise((res) => (pending[server] = res))) });
    // the agent kills the source's curl when it gets the signed command_cancel
    t.cancelCommand.mockImplementation((server: string) => {
      pending[server]?.({ exitCode: -1, output: "" });
      return true;
    });
    const r = await t.svc.transfer(req);
    expect(t.cancelCommand).toHaveBeenCalledWith("s1", expect.stringContaining("req-"));
    expect(t.cancel).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, recvExit: 66, sendExit: -1 });
    expect((r as { detail: string }).detail).toContain("target exit 66");
  });

  it("a send failure (curl 22) cancels the receive and reports both sides", async () => {
    let releaseRecv!: (v: { exitCode: number; output: string }) => void;
    const t = make({
      onSend: (server) => (server === "s1" ? Promise.resolve({ exitCode: 22, output: "curl: (22) The requested URL returned error: 404\n" }) : new Promise((res) => (releaseRecv = res))),
    });
    const p = t.svc.transfer(req);
    await new Promise((res) => setImmediate(res));
    expect(t.cancelCommand).toHaveBeenCalledWith("s2", expect.stringContaining("req-"));
    releaseRecv({ exitCode: -1, output: "killed" }); // the agent reports the killed command
    const r = await p;
    expect(r).toMatchObject({ ok: false, sendExit: 22, recvExit: -1 });
    expect((r as { detail: string }).detail).toContain("source exit 22");
    expect((r as { detail: string }).detail).toContain("target exit -1");
  });

  it("an agent error (offline / timeout) on one side is a failure with a scrubbed message and cancels the other", async () => {
    const t = make({ onSend: (server) => (server === "s2" ? Promise.reject(new Error("agent offline")) : Promise.resolve({ exitCode: -1, output: "" })) });
    const r = await t.svc.transfer(req);
    expect(r).toMatchObject({ ok: false, recvExit: null });
    expect((r as { detail: string }).detail).toContain("target: agent offline");
    expect(t.cancel).toHaveBeenCalled();
  });

  it("both commands succeed but WITHOUT their completion marker is not a success", async () => {
    const t = make({ onSend: async () => ({ exitCode: 0, output: "" }) });
    const r = await t.svc.transfer(req);
    expect(r).toMatchObject({ ok: false });
    expect((r as { detail: string }).detail).toContain("missing completion marker");
  });

  it("both commands succeed but the relay's counters differ from the signed part -> failure (never trusted blindly)", async () => {
    expect(await make({ done: Promise.resolve({ bytes: 999, sha256: SHA }) }).svc.transfer(req)).toMatchObject({ ok: false, detail: expect.stringContaining("relay counters") });
    expect(await make({ done: Promise.resolve({ bytes: 1000, sha256: "e".repeat(64) }) }).svc.transfer(req)).toMatchObject({ ok: false });
    const rejected = await make({ done: Promise.reject(new Error("relay idle timeout")) }).svc.transfer(req);
    expect(rejected).toMatchObject({ ok: false, detail: "relay idle timeout" });
  });

  it("the failure detail never contains a signed relay path", async () => {
    const t = make({ onSend: async (server) => ({ exitCode: 22, output: `curl failed for https://hub.example.com${server === "s1" ? SRC_PATH : DST_PATH}\n` }) });
    const r = await t.svc.transfer(req);
    expect((r as { detail: string }).detail).not.toMatch(/agent-vx|sig=|SIG/);
  });

  it("cancel() before the commands reach the wire kills them as soon as their reqIds exist, and kills the relay", async () => {
    let handle: { cancel(e: Error): void } | undefined;
    const t = make({ onSend: () => new Promise(() => undefined) });
    void t.svc.transfer(req, (h) => (handle = h));
    await new Promise((res) => setImmediate(res));
    handle!.cancel(new Error("move cancelled"));
    handle!.cancel(new Error("again")); // idempotent
    expect(t.cancel).toHaveBeenCalledTimes(1);
    expect(t.cancelCommand.mock.calls.map((c) => c[0]).sort()).toEqual(["s1", "s2"]);
  });
});
