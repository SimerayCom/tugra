import { verifySwapHosts } from "./swap-runtime";
import type { ServerFacts } from "./cutover-world.service";

const facts = (publicIp: string | null): ServerFacts => ({ id: "srv1", name: "box", teamId: "t1", publicIp, proxyBind: "public" });
const net = { sslAt: jest.fn(), httpAt: jest.fn() };

describe("verifySwapHosts: a server without a public IP is probed from the box itself", () => {
  it("sends the loopback probe on the host network (127.0.0.1 in the agent's container is the agent, nothing listens on :443 there)", async () => {
    const exec = jest.fn(async () => ({ exitCode: 0, output: "TUGRA_CUTOVER_PROBE status=200\n" }));
    const r = await verifySwapHosts({ world: { exec } as never, net }, facts("10.0.0.5"), ["a.example.com", "b.example.com"], "/");
    expect(r).toEqual({ "a.example.com": { ok: true, reason: "ok" }, "b.example.com": { ok: true, reason: "ok" } });
    expect(exec).toHaveBeenCalledTimes(2);
    for (const call of exec.mock.calls) {
      const c = call as unknown as unknown[];
      expect(c[0]).toBe("srv1");
      expect(String(c[1])).toContain('--resolve "$H:443:127.0.0.1"');
      expect(c[3]).toEqual({ hostNetwork: true });
    }
    expect(net.sslAt).not.toHaveBeenCalled();
  });

  it("a probe that does not answer is a failed host, never a pass", async () => {
    const exec = jest.fn(async () => ({ exitCode: 0, output: "TUGRA_CUTOVER_PROBE status=000\n" }));
    const r = await verifySwapHosts({ world: { exec } as never, net }, facts(null), ["a.example.com"], "/");
    expect(r["a.example.com"].ok).toBe(false);
  });
});
