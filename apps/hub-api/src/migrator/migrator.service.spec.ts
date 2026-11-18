import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { MigratorService, volumeDockerOptions } from "./migrator.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ApplicationsService } from "../applications/applications.service";
import { STACK, CUSTOM_STACK, OTHER_TUGRA, FOREIGN, AGENT_SELF, inspectLine } from "./testing/demo-containers";

describe("volumeDockerOptions (adopt carries named volumes so redeploy keeps data)", () => {
  it("carries named volumes as -v, dedupes by target, and skips bind/tmpfs", () => {
    const opts = volumeDockerOptions([
      { type: "volume", source: "wp_data", target: "/var/www/html" },
      { type: "bind", source: "/srv/x", target: "/data" }, // host bind — not carried
      { type: "volume", source: "wp_db", target: "/var/lib/mysql" },
      { type: "volume", source: "dupe", target: "/var/www/html" }, // same target — deduped
    ]);
    expect(opts).toBe("-v wp_data:/var/www/html -v wp_db:/var/lib/mysql");
  });
  it("returns null when there are no named volumes (unchanged adopt path)", () => {
    expect(volumeDockerOptions([{ type: "bind", source: "/srv/x", target: "/data" }])).toBeNull();
    expect(volumeDockerOptions([])).toBeNull();
  });
  it("fails closed on an unsafe volume name/target rather than dropping data", () => {
    expect(() => volumeDockerOptions([{ type: "volume", source: "bad name", target: "/d" }])).toThrow(BadRequestException);
    expect(() => volumeDockerOptions([{ type: "volume", source: "ok", target: "../etc" }])).toThrow(BadRequestException);
  });
});

const server = { id: "s1", teamId: "t1" };

function inspectJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Id: "cid",
    Name: "/legacy-web",
    State: { Status: "running" },
    Config: { Image: "nginx:1.25", Env: ["APP_ENV=prod", "DB_PASSWORD=s3cr3t"], Labels: {} },
    HostConfig: { PortBindings: { "80/tcp": [{ HostPort: "8080" }] }, RestartPolicy: { Name: "unless-stopped" } },
    Mounts: [],
    ...over,
  });
}

function make(over: {
  prisma?: Partial<PrismaService>;
  access?: Partial<TeamAccessService>;
  agentWs?: Partial<AgentWsServer>;
  apps?: Partial<ApplicationsService>;
} = {}) {
  const audit = { log: jest.fn() } as unknown as AuditService;
  const prisma =
    over.prisma ??
    ({ server: { findUnique: jest.fn().mockResolvedValue(server) }, application: { update: jest.fn() } } as unknown as PrismaService);
  const access =
    over.access ?? ({ requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService);
  const agentWs = over.agentWs ?? ({ sendCommand: jest.fn() } as unknown as AgentWsServer);
  const apps =
    over.apps ??
    ({
      create: jest.fn().mockResolvedValue({ id: "app1" }),
      get: jest.fn().mockResolvedValue({ id: "app1", name: "web" }),
      discardUndeployed: jest.fn().mockResolvedValue(undefined),
    } as unknown as ApplicationsService);
  const svc = new MigratorService(prisma as PrismaService, access as TeamAccessService, audit, agentWs as AgentWsServer, apps as ApplicationsService);
  return { svc, prisma, access, agentWs, apps, audit };
}

describe("MigratorService", () => {
  describe("discover", () => {
    it("forbids a viewer (no apps:config)", async () => {
      const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("insufficient role")) } as unknown as TeamAccessService;
      const { svc } = make({ access });
      await expect(svc.discover("u1", "s1")).rejects.toThrow(/insufficient role/);
    });

    it("scans with the 'deploy' capability, drops Tugra containers, flags compose as not adoptable", async () => {
      const out = [
        inspectJson({ Name: "/legacy-web" }),
        inspectJson({ Name: "/tugra_clx1" }), // Tugra app → excluded
        inspectJson({ Name: "/tugra-proxy" }), // infra → excluded
        inspectJson({ Name: "/stack-db-1", Config: { Image: "pg:16", Env: [], Labels: { "com.docker.compose.project": "stack" } } }),
      ].join("\n");
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: out, exitCode: 0 }) } as unknown as AgentWsServer;
      const { svc } = make({ agentWs });
      const { containers } = await svc.discover("u1", "s1");
      expect((agentWs.sendCommand as jest.Mock).mock.calls[0][2]).toBe("deploy");
      expect(containers.map((c) => c.name)).toEqual(["legacy-web", "stack-db-1"]);
      expect(containers.find((c) => c.name === "legacy-web")!.adoptable).toBe(true);
      expect(containers.find((c) => c.name === "stack-db-1")!.adoptable).toBe(false);
    });

    it("never lists Tugra's own stack, proxy, tunnel, helpers or managed containers; foreign ones still show", async () => {
      const own = [...Object.values(STACK), ...Object.values(CUSTOM_STACK), ...Object.values(OTHER_TUGRA)];
      const foreign = Object.values(FOREIGN);
      const out = [`TUGRA_SELF=${AGENT_SELF}`, ...own, ...foreign].join("\n");
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: out, exitCode: 0 }) } as unknown as AgentWsServer;
      const { svc } = make({ agentWs });
      const { containers } = await svc.discover("u1", "s1");
      expect(containers.map((c) => c.name)).toEqual(["legacy-web", "my-tugra-blog", "shop-db-1", "shop-web-1", "my-tunnel", "immich_machine_learning"]);
      expect(containers.find((c) => c.name === "legacy-web")!.adoptable).toBe(true);
      expect(containers.find((c) => c.name === "shop-db-1")!.adoptable).toBe(false);
      // classifier-internal fields never reach the client
      expect(Object.keys(containers[0])).not.toContain("tugraReason");
      expect(Object.keys(containers[0])).not.toContain("labelKeys");
    });

    it("throws a clear error (not an empty list) when Docker is unavailable", async () => {
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: "TUGRA_NO_DOCKER\n", exitCode: 0 }) } as unknown as AgentWsServer;
      const { svc } = make({ agentWs });
      await expect(svc.discover("u1", "s1")).rejects.toThrow(/Docker is not available/);
    });

    it("masks env VALUES in the discover response (keys kept) — no secrets over the wire", async () => {
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: inspectJson(), exitCode: 0 }) } as unknown as AgentWsServer;
      const { svc } = make({ agentWs });
      const { containers } = await svc.discover("u1", "s1");
      expect(containers[0].env.map((e) => e.key)).toEqual(["APP_ENV", "DB_PASSWORD"]);
      expect(containers[0].env.every((e) => e.value === "")).toBe(true);
      expect(JSON.stringify(containers)).not.toContain("s3cr3t");
    });
  });

  describe("adopt", () => {
    function agentSeq(inspectOut: string, renameExit = 0) {
      return {
        sendCommand: jest
          .fn()
          .mockResolvedValueOnce({ output: inspectOut, exitCode: 0 }) // fresh re-inspect
          .mockResolvedValueOnce({ output: "", exitCode: renameExit }), // rename
      } as unknown as AgentWsServer;
    }

    it("creates the app (exposeMode none, deploy false, mapped image/port/env), renames, sets status", async () => {
      const agentWs = agentSeq(inspectJson());
      const { svc, apps, prisma, audit } = make({ agentWs });
      const res = await svc.adopt("u1", "s1", { container: "legacy-web", name: "web" });

      const createArg = (apps.create as jest.Mock).mock.calls[0][1];
      expect(createArg).toMatchObject({
        name: "web",
        serverId: "s1",
        source: "IMAGE",
        image: "nginx:1.25",
        hostPort: 8080,
        containerPort: 80,
        exposeMode: "none",
        deploy: false,
        env: { APP_ENV: "prod", DB_PASSWORD: "s3cr3t" },
      });
      // rename command targets tugra_<appId>
      expect((agentWs.sendCommand as jest.Mock).mock.calls[1][1]).toBe("docker rename legacy-web tugra_app1");
      expect((prisma.application!.update as jest.Mock)).toHaveBeenCalledWith({ where: { id: "app1" }, data: { status: "RUNNING" } });
      expect(audit.log).toHaveBeenCalled();
      expect(res).toEqual({ id: "app1", name: "web" });
    });

    it("passes hostPort UNDEFINED (never null) when the container has no published port", async () => {
      const agentWs = agentSeq(inspectJson({ HostConfig: { PortBindings: {}, RestartPolicy: { Name: "no" } }, Config: { Image: "x:1", Env: [], Labels: {} } }));
      const { svc, apps } = make({ agentWs });
      await svc.adopt("u1", "s1", { container: "legacy-web", name: "web" });
      const createArg = (apps.create as jest.Mock).mock.calls[0][1];
      expect(createArg.hostPort).toBeUndefined();
      expect("hostPort" in createArg && createArg.hostPort === null).toBe(false);
      expect(createArg.containerPort).toBe(80); // default when no port at all
    });

    it("compensating-deletes the app row when rename fails, then throws", async () => {
      const agentWs = agentSeq(inspectJson(), 1); // rename exitCode 1
      const { svc, apps, prisma } = make({ agentWs });
      await expect(svc.adopt("u1", "s1", { container: "legacy-web", name: "web" })).rejects.toThrow(/could not adopt/);
      expect(apps.discardUndeployed as jest.Mock).toHaveBeenCalledWith("app1");
      expect(prisma.application!.update as jest.Mock).not.toHaveBeenCalled();
    });

    it("compensating-deletes the app row when the rename command REJECTS (agent offline/timeout)", async () => {
      const agentWs = {
        sendCommand: jest
          .fn()
          .mockResolvedValueOnce({ output: inspectJson(), exitCode: 0 }) // inspect
          .mockRejectedValueOnce(new Error("agent offline")), // rename throws, not resolves
      } as unknown as AgentWsServer;
      const { svc, apps, prisma } = make({ agentWs });
      await expect(svc.adopt("u1", "s1", { container: "legacy-web", name: "web" })).rejects.toThrow(/agent unavailable/);
      expect(apps.discardUndeployed as jest.Mock).toHaveBeenCalledWith("app1");
      expect(prisma.application!.update as jest.Mock).not.toHaveBeenCalled();
    });

    it("rejects an out-of-range portIndex instead of silently dropping the port", async () => {
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: inspectJson(), exitCode: 0 }) } as unknown as AgentWsServer; // 1 port
      const { svc, apps } = make({ agentWs });
      await expect(svc.adopt("u1", "s1", { container: "legacy-web", name: "web", portIndex: 5 })).rejects.toThrow(/not available/);
      expect(apps.create as jest.Mock).not.toHaveBeenCalled();
    });

    it("rejects a Tugra-owned container on the fresh re-inspect (no create)", async () => {
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: inspectJson({ Name: "/tugra_cmwgxy1zm0j4nnm1a0cfjrm4j" }), exitCode: 0 }) } as unknown as AgentWsServer;
      const { svc, apps } = make({ agentWs });
      await expect(svc.adopt("u1", "s1", { container: "tugra_cmwgxy1zm0j4nnm1a0cfjrm4j", name: "x" })).rejects.toThrow(/already managed/);
      expect(apps.create as jest.Mock).not.toHaveBeenCalled();
    });

    describe("refuses Tugra's own containers server-side (direct API / MCP / CLI call)", () => {
      const ownCases: Array<[string, string, RegExp]> = [
        ...Object.entries(STACK).map(([k, line]) => [`stack ${k}`, line, /install stack/] as [string, string, RegExp]),
        ["proxy", OTHER_TUGRA.proxy, /reverse proxy/],
        ["tunnel", OTHER_TUGRA.tunnel, /tunnel/],
        ["vx helper", OTHER_TUGRA.vx, /helper/],
        ["patch helper", OTHER_TUGRA.patch, /helper/],
        ["reboot helper", OTHER_TUGRA.reboot, /helper/],
        ["migrator helper", OTHER_TUGRA.migrator, /helper/],
        ["objmig helper", OTHER_TUGRA.objmig, /helper/],
        ["managed app", OTHER_TUGRA.app, /already managed/],
        ["managed db", OTHER_TUGRA.db, /already managed/],
        ["managed compose service", OTHER_TUGRA.composeSvc, /already managed/],
        ["label-only", OTHER_TUGRA.labelled, /helper/],
      ];
      it.each(ownCases)("%s -> 400, no app record, no rename", async (_n, line, re) => {
        const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: line, exitCode: 0 }) } as unknown as AgentWsServer;
        const { svc, apps } = make({ agentWs });
        const name = JSON.parse(line).Name.slice(1) as string;
        await expect(svc.adopt("u1", "s1", { container: name, name: "x" })).rejects.toThrow(BadRequestException);
        await expect(svc.adopt("u1", "s1", { container: name, name: "x" })).rejects.toThrow(re);
        expect(apps.create).not.toHaveBeenCalled();
        expect((agentWs.sendCommand as jest.Mock).mock.calls.every((c) => !String(c[1]).includes("docker rename"))).toBe(true);
      });

      it("bundled postgres of a custom-named stack: refused as Tugra's own after a host-wide classification", async () => {
        const full = ["TUGRA_SELF=whatever", CUSTOM_STACK.hub, CUSTOM_STACK.pg].join("\n");
        const agentWs = {
          sendCommand: jest.fn().mockResolvedValueOnce({ output: CUSTOM_STACK.pg, exitCode: 0 }).mockResolvedValueOnce({ output: full, exitCode: 0 }),
        } as unknown as AgentWsServer;
        const { svc, apps } = make({ agentWs });
        await expect(svc.adopt("u1", "s1", { container: "panel-postgres-1", name: "x" })).rejects.toThrow(/install stack/);
        expect(apps.create).not.toHaveBeenCalled();
      });

      it("a reserved-name container is refused with a distinct message", async () => {
        const line = inspectLine({ name: "tugra_blog", image: "wordpress:6" });
        const { svc, apps } = make({ agentWs: agentSeq(line) });
        await expect(svc.adopt("u1", "s1", { container: "tugra_blog", name: "x" })).rejects.toThrow(/reserved for Tugra/);
        expect(apps.create).not.toHaveBeenCalled();
      });

      it("a compose member the host-wide scan cannot classify (scan rejects) still gets the 400, not a 5xx", async () => {
        const agentWs = {
          sendCommand: jest.fn().mockResolvedValueOnce({ output: FOREIGN.composeApp, exitCode: 0 }).mockRejectedValueOnce(new Error("agent timeout")),
        } as unknown as AgentWsServer;
        const { svc, apps } = make({ agentWs });
        await expect(svc.adopt("u1", "s1", { container: "shop-db-1", name: "x" })).rejects.toThrow(BadRequestException);
        expect(apps.create).not.toHaveBeenCalled();
      });

      it("a regular foreign container is still adopted", async () => {
        const agentWs = agentSeq(FOREIGN.web);
        const { svc, apps } = make({ agentWs });
        await svc.adopt("u1", "s1", { container: "legacy-web", name: "web" });
        expect(apps.create).toHaveBeenCalledTimes(1);
      });
    });

    it("rejects a compose-managed container", async () => {
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: inspectJson({ Config: { Image: "pg:16", Env: [], Labels: { "com.docker.compose.project": "stack" } } }), exitCode: 0 }) } as unknown as AgentWsServer;
      const { svc, apps } = make({ agentWs });
      await expect(svc.adopt("u1", "s1", { container: "legacy-web", name: "x" })).rejects.toThrow(/compose/);
      expect(apps.create as jest.Mock).not.toHaveBeenCalled();
    });

    it("404s when the container is gone (empty inspect output — discover→adopt race)", async () => {
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: "", exitCode: 1 }) } as unknown as AgentWsServer;
      const { svc, apps } = make({ agentWs });
      await expect(svc.adopt("u1", "s1", { container: "gone", name: "x" })).rejects.toThrow(/not found/);
      expect(apps.create as jest.Mock).not.toHaveBeenCalled();
    });

    it("forbids a viewer BEFORE any agent round-trip", async () => {
      const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("insufficient role")) } as unknown as TeamAccessService;
      const agentWs = { sendCommand: jest.fn() } as unknown as AgentWsServer;
      const { svc } = make({ access, agentWs });
      await expect(svc.adopt("u1", "s1", { container: "legacy-web", name: "x" })).rejects.toThrow(/insufficient role/);
      expect(agentWs.sendCommand as jest.Mock).not.toHaveBeenCalled();
    });

    it("never puts an imported env value into the audit log", async () => {
      const agentWs = agentSeq(inspectJson()); // env has DB_PASSWORD=s3cr3t
      const { svc, audit } = make({ agentWs });
      await svc.adopt("u1", "s1", { container: "legacy-web", name: "web" });
      expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain("s3cr3t");
    });
  });

  describe("unadopt (importer rollback)", () => {
    it("renames the container back (exit 0) THEN drops the app record + audits", async () => {
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: "", exitCode: 0 }) } as unknown as AgentWsServer;
      const { svc, apps, agentWs: ws, audit } = make({ agentWs });
      await svc.unadopt("u1", "s1", "app1", "legacy-web");
      expect((ws.sendCommand as jest.Mock).mock.calls[0][1]).toContain("docker rename tugra_app1 legacy-web");
      expect(apps.discardUndeployed as jest.Mock).toHaveBeenCalledWith("app1");
      expect(audit.log).toHaveBeenCalled();
    });

    it("treats a vanished container as success (exit 0 via marker) and still drops the record", async () => {
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: "TUGRA_CONTAINER_GONE\n", exitCode: 0 }) } as unknown as AgentWsServer;
      const { svc, apps } = make({ agentWs });
      await svc.unadopt("u1", "s1", "app1", "legacy-web");
      expect(apps.discardUndeployed as jest.Mock).toHaveBeenCalledWith("app1");
    });

    it("THROWS and does NOT delete the record when the rename fails (non-zero exit) — no false rollback", async () => {
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: "name in use", exitCode: 1 }) } as unknown as AgentWsServer;
      const { svc, apps } = make({ agentWs });
      await expect(svc.unadopt("u1", "s1", "app1", "legacy-web")).rejects.toThrow(/could not roll back/);
      expect(apps.discardUndeployed as jest.Mock).not.toHaveBeenCalled();
    });

    it("THROWS and does NOT delete the record when the agent is offline (reject)", async () => {
      const agentWs = { sendCommand: jest.fn().mockRejectedValue(new Error("agent offline")) } as unknown as AgentWsServer;
      const { svc, apps } = make({ agentWs });
      await expect(svc.unadopt("u1", "s1", "app1", "legacy-web")).rejects.toThrow(/agent unavailable/);
      expect(apps.discardUndeployed as jest.Mock).not.toHaveBeenCalled();
    });

    it("forbids a viewer before any agent round-trip", async () => {
      const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("insufficient role")) } as unknown as TeamAccessService;
      const agentWs = { sendCommand: jest.fn() } as unknown as AgentWsServer;
      const { svc } = make({ access, agentWs });
      await expect(svc.unadopt("u1", "s1", "app1", "legacy-web")).rejects.toThrow(/insufficient role/);
      expect(agentWs.sendCommand as jest.Mock).not.toHaveBeenCalled();
    });
  });
});

describe("MigratorService.adopt — env values with line breaks", () => {
  function agentSeq(inspectOut: string) {
    return {
      sendCommand: jest.fn().mockResolvedValueOnce({ output: inspectOut, exitCode: 0 }).mockResolvedValueOnce({ output: "", exitCode: 0 }),
    } as unknown as AgentWsServer;
  }
  const withEnv = (env: string[]) => inspectJson({ Config: { Image: "nginx:1.25", Env: env, Labels: {} } });

  it("a PEM-style value is adopted with the Multiline flag set", async () => {
    const { svc, apps } = make({ agentWs: agentSeq(withEnv(["TLS_KEY=-----BEGIN-----\nabc\n-----END-----", "PLAIN=1"])) });
    await svc.adopt("u1", "s1", { container: "legacy-web", name: "web" });
    const arg = (apps.create as jest.Mock).mock.calls[0][1];
    expect(arg.env.TLS_KEY).toBe("-----BEGIN-----\nabc\n-----END-----");
    expect(arg.envFlags).toEqual({ TLS_KEY: { multiline: true } });
  });

  it("a line break on a name that cannot be multiline rejects the adopt before any write", async () => {
    const agentWs = agentSeq(withEnv(["LD_PRELOAD=a\nb"]));
    const { svc, apps } = make({ agentWs });
    await expect(svc.adopt("u1", "s1", { container: "legacy-web", name: "web" })).rejects.toThrow(/cannot adopt: env var "LD_PRELOAD"/);
    expect(apps.create).not.toHaveBeenCalled();
    expect((agentWs.sendCommand as jest.Mock)).toHaveBeenCalledTimes(1); // inspect only, no rename
  });

  it("an env without line breaks creates no envFlags key", async () => {
    const { svc, apps } = make({ agentWs: agentSeq(inspectJson()) });
    await svc.adopt("u1", "s1", { container: "legacy-web", name: "web" });
    expect("envFlags" in (apps.create as jest.Mock).mock.calls[0][1]).toBe(false);
  });
});
