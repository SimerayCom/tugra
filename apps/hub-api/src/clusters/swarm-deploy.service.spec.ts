import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { SwarmDeployService, appEnvConfigHash, effectivePollSec } from "./swarm-deploy.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { Application } from "@prisma/client";
import type { AppSpec } from "../deploy/deploy-script";

function app(over: Partial<Application> = {}): Application {
  return {
    id: "abc",
    clusterId: "c1",
    source: "IMAGE",
    image: "ghcr.io/org/app:1",
    buildServerId: null,
    hostPort: null,
    replicas: 3,
    healthCmd: null,
    ...(over as object),
  } as unknown as Application;
}

function spec(over: Partial<AppSpec> = {}): AppSpec {
  return {
    id: "abc",
    source: "IMAGE",
    image: "ghcr.io/org/app:1",
    env: {},
    containerPort: 80,
    hostPort: null,
    ...over,
  } as AppSpec;
}

function make(opts: { swarmStatus?: string; swarmManagerId?: string | null; managerStatus?: string; backupManagerId?: string | null; sendImpl?: jest.Mock } = {}) {
  const cluster = { swarmStatus: opts.swarmStatus ?? "ACTIVE", swarmManagerId: opts.swarmManagerId ?? "mgr" };
  const prisma = {
    cluster: { findUnique: jest.fn().mockResolvedValue(cluster) },
    server: {
      findUnique: jest.fn().mockResolvedValue({ status: opts.managerStatus ?? "ONLINE" }),
      // FLEET-G failover: the primary being offline triggers a search for any other online MANAGER.
      findFirst: jest.fn().mockResolvedValue(opts.backupManagerId ? { id: opts.backupManagerId } : null),
    },
  } as unknown as PrismaService;
  const send =
    opts.sendImpl ??
    jest.fn(async (_serverId: string, _cmd: string, _cap: string) => ({ exitCode: 0, output: "TUGRA_ROLLOUT: converged\nTUGRA_SVC_DIGEST=ghcr.io/org/app@sha256:dd" }));
  const agent = { sendCommand: send } as unknown as AgentWsServer;
  const swarmProxy = { ensure: jest.fn().mockResolvedValue(undefined) } as unknown as import("./swarm-proxy.service").SwarmProxyService;
  return { svc: new SwarmDeployService(prisma, agent, swarmProxy), send, prisma, swarmProxy };
}

describe("SwarmDeployService.resolveManager", () => {
  it("returns the manager id for an ACTIVE (or DEGRADED) swarm", async () => {
    expect(await make({ swarmStatus: "ACTIVE" }).svc.resolveManager("c1")).toBe("mgr");
    expect(await make({ swarmStatus: "DEGRADED" }).svc.resolveManager("c1")).toBe("mgr");
  });
  it("blocks NONE / FORMING / DISSOLVING", async () => {
    for (const st of ["NONE", "FORMING", "DISSOLVING"]) {
      await expect(make({ swarmStatus: st }).svc.resolveManager("c1")).rejects.toBeInstanceOf(BadRequestException);
    }
  });
  it("errors when the manager is offline and there is no other online manager to fail over to", async () => {
    await expect(make({ managerStatus: "OFFLINE" }).svc.resolveManager("c1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it("FLEET-G: fails over to another ONLINE manager when the primary is offline", async () => {
    const { svc, prisma } = make({ managerStatus: "OFFLINE", backupManagerId: "mgr2" });
    expect(await svc.resolveManager("c1")).toBe("mgr2");
    // the fallback query excludes the primary and requires an online swarm-capable manager
    expect((prisma.server.findFirst as unknown as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clusterId: "c1", swarmRole: "MANAGER", status: "ONLINE", NOT: { id: "mgr" } }) }),
    );
  });
});

describe("SwarmDeployService.deploy", () => {
  it("IMAGE: ensures the overlay + deploys the service on the MANAGER under the swarm capability", async () => {
    const { svc, send } = make();
    const r = await svc.deploy(app(), spec(), "dep1", { timeoutMs: 300_000 });
    expect(send).toHaveBeenCalledTimes(1); // no separate build step for IMAGE
    const [serverId, script, cap] = send.mock.calls[0];
    expect(serverId).toBe("mgr");
    expect(cap).toBe("swarm");
    expect(script).toContain("docker network create -d overlay --opt encrypted --attachable 'tugra-swarm'");
    expect(script).toContain("docker service create --detach");
    expect(script).toContain("'ghcr.io/org/app:1'");
    expect(r).toMatchObject({ exitCode: 0, digest: "ghcr.io/org/app@sha256:dd", registryRef: null });
  });

  it("GIT: builds+pushes on the build target first, then deploys the pushed ref on the manager", async () => {
    const send = jest.fn(async (serverId: string, _cmd: string, _cap: string) =>
      serverId === "build1"
        ? { exitCode: 0, output: "built" }
        : { exitCode: 0, output: "TUGRA_ROLLOUT: converged" },
    );
    const { svc } = make({ sendImpl: send });
    await svc.deploy(
      app({ source: "GIT", buildServerId: "build1" }),
      spec({ source: "GIT", registryPush: { auth: { user: "u", token: "t" }, tag: "reg/tugra_abc:dep1" } }),
      "dep1",
      { timeoutMs: 300_000 },
    );
    expect(send.mock.calls[0][0]).toBe("build1"); // build first
    expect(send.mock.calls[0][2]).toBe("deploy");
    expect(send.mock.calls[1][0]).toBe("mgr"); // then service on manager
    expect(send.mock.calls[1][2]).toBe("swarm");
    expect(send.mock.calls[1][1]).toContain("'reg/tugra_abc:dep1'"); // the pushed ref
  });

  it("GIT without a registry is rejected (a swarm needs an all-nodes-pullable image)", async () => {
    const { svc } = make();
    await expect(svc.deploy(app({ source: "GIT" }), spec({ source: "GIT" }), "dep1", { timeoutMs: 1000 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("propagates a build failure", async () => {
    const send = jest.fn(async (_serverId: string, _cmd: string, _cap: string) => ({ exitCode: 1, output: "boom" }));
    const { svc } = make({ sendImpl: send });
    await expect(
      svc.deploy(app({ source: "GIT" }), spec({ source: "GIT", registryPush: { auth: { user: "u", token: "t" }, tag: "reg/x:1" } }), "dep1", { timeoutMs: 1000 }),
    ).rejects.toThrow(/build failed/);
  });

  it("publishes a routing-mesh port for a domain-less app with a host port", async () => {
    const { svc, send } = make();
    await svc.deploy(app({ hostPort: 8080 }), spec({ containerPort: 80 }), "dep1", { timeoutMs: 1000 });
    expect(send.mock.calls[0][1]).toContain("--publish '8080:80'");
  });

  it("renders spec placement into --constraint/--placement-pref (shared by deploy + rollback)", async () => {
    const { svc, send } = make();
    await svc.deploy(
      app(),
      spec({ placementConstraints: [{ type: "hostname", op: "eq", value: "web-1" }], placementSpreadLabelKey: "zone" }),
      "dep1",
      { timeoutMs: 1000 },
    );
    const script = send.mock.calls[0][1] as string;
    expect(script).toContain("--constraint 'node.hostname==web-1'");
    expect(script).toContain("--placement-pref 'spread=node.labels.zone'");
  });

  it("mounts named volumes for a stateful app (FLEET-E), sourced from spec.volumes", async () => {
    const { svc, send } = make();
    await svc.deploy(app(), spec({ volumes: [{ name: "data", path: "/var/lib/data" }] }), "dep1", { timeoutMs: 1000 });
    const script = send.mock.calls[0][1] as string;
    expect(script).toContain("--mount 'type=volume,source=");
    expect(script).toContain("destination=/var/lib/data'");
  });

  it("domain app: ensures the swarm proxy and attaches Traefik SERVICE labels (no host publish)", async () => {
    const { svc, send, swarmProxy } = make();
    await svc.deploy(
      app({ hostPort: 8080 }),
      spec({ domain: "app.example.com", containerPort: 80, certType: "le-http" }),
      "dep1",
      { timeoutMs: 1000 },
    );
    expect((swarmProxy as unknown as { ensure: jest.Mock }).ensure).toHaveBeenCalledWith("c1");
    const script = send.mock.calls[0][1] as string;
    expect(script).toContain("--label 'traefik.enable=true'");
    expect(script).not.toContain("--publish"); // a routed app goes through Traefik over the overlay, not a host port
  });
});

describe("SwarmDeployService.rollbackTo", () => {
  it("updates the service to a prior ref on the manager WITHOUT rebuilding (single dispatch)", async () => {
    const { svc, send } = make();
    const r = await svc.rollbackTo(app({ source: "GIT" }), spec({ source: "GIT" }), "reg/tugra_abc:old", { user: "u", token: "t" }, {});
    expect(send).toHaveBeenCalledTimes(1); // no build step — just the service update
    const [serverId, script, cap] = send.mock.calls[0];
    expect(serverId).toBe("mgr");
    expect(cap).toBe("swarm");
    expect(script).toContain("'reg/tugra_abc:old'");
    expect(r.exitCode).toBe(0);
  });
});

describe("effectivePollSec", () => {
  it("scales with replica count (a flat timeout would falsely FAIL big rollouts)", () => {
    expect(effectivePollSec(1, null)).toBeLessThan(effectivePollSec(5, null));
    expect(effectivePollSec(3, "curl -f x")).toBeGreaterThan(effectivePollSec(3, null)); // health widens the monitor
    expect(effectivePollSec(1000, null)).toBeLessThanOrEqual(900); // capped
  });
});

describe("SwarmDeployService.resolveTaskExec", () => {
  function setup(o: { ps?: string; container?: string; members?: unknown[] } = {}) {
    const cluster = { swarmStatus: "ACTIVE", swarmManagerId: "mgr" };
    const send = jest.fn(async (_serverId: string, cmd: string, _cap: string) => {
      if (cmd.includes("docker service ps")) {
        return { exitCode: 0, output: o.ps ?? '{"Node":"host-mgr","CurrentState":"Running 2 seconds ago","Name":"tugra_abc.1"}' };
      }
      if (cmd.includes("docker ps --filter label=com.docker.swarm.service.name")) {
        return { exitCode: 0, output: o.container ?? "tugra_abc.1.xyz\n" };
      }
      return { exitCode: 0, output: "" };
    });
    const prisma = {
      cluster: { findUnique: jest.fn().mockResolvedValue(cluster) },
      server: {
        findUnique: jest.fn().mockResolvedValue({ status: "ONLINE" }),
        findMany: jest.fn().mockResolvedValue(o.members ?? [{ id: "mgr", hostname: "host-mgr", status: "ONLINE", capabilities: ["terminal", "deploy"] }]),
      },
    } as unknown as PrismaService;
    const svc = new SwarmDeployService(prisma, { sendCommand: send } as unknown as AgentWsServer, { ensure: jest.fn() } as unknown as import("./swarm-proxy.service").SwarmProxyService);
    return { svc, send };
  }

  it("picks a running replica on a terminal-capable ONLINE node (prefers the manager) + its container", async () => {
    const { svc } = setup();
    expect(await svc.resolveTaskExec(app())).toEqual({ serverId: "mgr", container: "tugra_abc.1.xyz" });
  });

  it("errors when no node running a replica has the terminal capability granted", async () => {
    const { svc } = setup({ members: [{ id: "mgr", hostname: "host-mgr", status: "ONLINE", capabilities: ["deploy"] }] });
    await expect(svc.resolveTaskExec(app())).rejects.toBeInstanceOf(BadRequestException);
  });

  it("errors when there is no running replica", async () => {
    const { svc } = setup({ ps: '{"Node":"host-mgr","CurrentState":"Failed 2 seconds ago","Name":"tugra_abc.1"}' });
    await expect(svc.resolveTaskExec(app())).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("SwarmDeployService lifecycle", () => {
  it("scale / remove / status / logs dispatch the right script to the manager under swarm cap", async () => {
    const { svc, send } = make();
    await svc.scale(app(), 0);
    // scale() now polls to convergence (like restart()): dispatch to the manager under the swarm cap, with a
    // sized WS timeout, and a script that both scales and polls.
    expect(send.mock.calls[0][0]).toBe("mgr");
    expect(send.mock.calls[0][1]).toContain("docker service scale --detach 'tugra_abc'=0");
    expect(send.mock.calls[0][1]).toContain("TUGRA_ROLLOUT");
    expect(send.mock.calls[0][2]).toBe("swarm");
    expect(typeof send.mock.calls[0][3]).toBe("number");
    await svc.remove(app());
    expect(send.mock.calls[1][1]).toContain("docker service rm 'tugra_abc' 2>/dev/null || true");
    expect(send.mock.calls[1][1]).toContain("tugra-appenv-tugra_abc"); // FLEET-F: also prunes env secrets
    await svc.status(app());
    expect(send.mock.calls[2][1]).toContain("docker service ps 'tugra_abc'");
    await svc.logs(app(), 50);
    expect(send.mock.calls[3][1]).toBe("docker service logs --timestamps --tail 50 'tugra_abc'");
  });
});

describe("SwarmDeployService FLEET-F — env secrets", () => {
  it("appEnvConfigHash is order-independent and content-sensitive", () => {
    expect(appEnvConfigHash({ FOO: "a", BAR: "b" })).toBe(appEnvConfigHash({ BAR: "b", FOO: "a" }));
    expect(appEnvConfigHash({ FOO: "a" })).not.toBe(appEnvConfigHash({ FOO: "b" }));
  });

  it("no env → a single deploy call (no image-inspect round trip)", async () => {
    const { svc, send } = make();
    await svc.deploy(app(), spec({ env: {} }), "dep1", { timeoutMs: 1000 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("env + shell → inspect then deploy; env rides a secret, raw value never in the script", async () => {
    const send = jest.fn(async (_s: string, cmd: string) =>
      cmd.includes("TUGRA_ENTRYPOINT")
        ? { exitCode: 0, output: 'TUGRA_ENTRYPOINT=null\nTUGRA_CMD=["node","server.js"]\nTUGRA_HAS_SHELL=yes' }
        : { exitCode: 0, output: "TUGRA_ROLLOUT: converged" },
    );
    const { svc } = make({ sendImpl: send });
    await svc.deploy(app(), spec({ env: { FOO: "bar" } }), "dep1", { timeoutMs: 1000 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1]).toContain("docker pull -q"); // inspect first
    const deployScript = send.mock.calls[1][1] as string;
    expect(deployScript).toContain("--secret source="); // env via secret
    expect(deployScript).not.toContain("FOO=bar"); // never plaintext
  });

  it("env + NO shell (distroless) → falls back to plaintext env, never breaks the app", async () => {
    const send = jest.fn(async (_s: string, cmd: string) =>
      cmd.includes("TUGRA_ENTRYPOINT")
        ? { exitCode: 0, output: "TUGRA_ENTRYPOINT=null\nTUGRA_CMD=null\nTUGRA_HAS_SHELL=no" }
        : { exitCode: 0, output: "TUGRA_ROLLOUT: converged" },
    );
    const { svc } = make({ sendImpl: send });
    await svc.deploy(app(), spec({ env: { FOO: "bar" } }), "dep1", { timeoutMs: 1000 });
    const deployScript = send.mock.calls[1][1] as string;
    expect(deployScript).not.toContain("--secret source=");
    expect(deployScript).toContain("--env 'FOO'"); // classic plaintext path — distroless app still runs
  });

  it("inspect failure aborts the deploy with a clear error (deploy script never dispatched)", async () => {
    const send = jest.fn(async (_s: string, cmd: string) =>
      cmd.includes("TUGRA_ENTRYPOINT") ? { exitCode: 1, output: "pull denied" } : { exitCode: 0, output: "TUGRA_ROLLOUT: converged" },
    );
    const { svc } = make({ sendImpl: send });
    await expect(svc.deploy(app(), spec({ env: { FOO: "bar" } }), "dep1", { timeoutMs: 1000 })).rejects.toThrow(/pull\/inspect|protect/i);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
