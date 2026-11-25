import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { Pm2MoveService, type JobView } from "./pm2-move.service";
import { PM2_BEGIN, PM2_END, PM2_OUTDATED } from "./pm2-facts";
import { planProcess } from "./pm2-plan";
import { parsePm2Facts } from "./pm2-facts";

const CWD = "/home/acme/htdocs/app.example.com";
const SECRET = "s3cr3t-DB-password";

const factJson = (over: Record<string, unknown> = {}, withEnv = false) => ({
  name: "app",
  nameExact: true,
  status: "online",
  script: `${CWD}/server.js`,
  cwd: CWD,
  interpreter: "/home/acme/.nvm/versions/node/v20.11.1/bin/node",
  mode: "fork",
  instances: 1,
  argsOverflow: false,
  args: ["--port", "3000"],
  nodeArgs: [],
  interpreterArgs: [],
  port: 3000,
  envCount: 2,
  envSkipped: 14,
  envDigest: "e".repeat(64),
  ...(withEnv ? { env: { PORT: "3000", DB_PASSWORD: SECRET } } : {}),
  cwdExists: true,
  scriptExists: true,
  cwdUid: 1001,
  cwdGid: 1001,
  ...over,
});
const doc = (procs: unknown[]) => `${PM2_BEGIN}\n${JSON.stringify({ v: 1, users: [{ user: "acme", home: "/home/acme", uid: 1001, gid: 1001, daemon: true, procs }], errors: [] })}\n${PM2_END}\n`;

// The plan the service will compute for the default fact, to get a matching hash for the request.
function hashFor(over: Record<string, unknown> = {}, override: { nodeMajor?: number; probePath?: string | null } = {}) {
  const parsed = parsePm2Facts(doc([factJson(over)]));
  if (parsed.status !== "ok") throw new Error("bad fixture");
  return planProcess(parsed.users[0], parsed.users[0].procs[0], { sites: [], override }).plan.planHash;
}

function setup(over: { move?: (script: string) => { exitCode: number; output: string } | Error; recover?: (script: string) => { exitCode: number; output: string } | Error; facts?: (script: string) => string; caps?: string[] } = {}) {
  const calls: { script: string; cap: string }[] = [];
  const sendCommand = jest.fn(async (_id: string, script: string, cap: string) => {
    calls.push({ script, cap });
    if (script.includes("pm2 --root=/host")) return { exitCode: 0, output: (over.facts ?? ((s) => doc([factJson({}, s.includes(" --env")) ]))) (script) };
    const handler = script.includes('M "step=recover"') ? over.recover : over.move;
    const r = handler ? handler(script) : { exitCode: 0, output: "TUGRA_PM2MOVE: step=precheck\nTUGRA_PM2MOVE: result=moved reason=ok\n" };
    if (r instanceof Error) throw r;
    return r;
  });
  const agentWs = { sendCommand, isCapabilityGranted: jest.fn(async (_s: string, c: string) => (over.caps ?? ["patch", "deploy", "bulk"]).includes(c)) };
  const appUpdate = jest.fn().mockResolvedValue({});
  const depUpdate = jest.fn().mockResolvedValue({});
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", scanReport: null, scannedAt: null }) },
    environment: { findFirst: jest.fn().mockResolvedValue({ id: "env1" }) },
    application: { update: appUpdate },
    deployment: { create: jest.fn().mockResolvedValue({ id: "dep1" }), update: depUpdate },
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const apps = {
    create: jest.fn().mockResolvedValue({ id: "app1" }),
    discardUndeployed: jest.fn().mockResolvedValue(undefined),
    buildLocalRunScript: jest.fn().mockResolvedValue("docker run -d --name tugra_app1 node:20 node server.js"),
  };
  const svc = new Pm2MoveService(prisma as never, access as never, audit as never, agentWs as never, apps as never);
  return { svc, calls, sendCommand, agentWs, prisma, appUpdate, depUpdate, access, audit, apps };
}

async function done(svc: Pm2MoveService, start: JobView): Promise<JobView> {
  for (let i = 0; i < 200; i++) {
    const j = await svc.getJob("u1", "s1", start.id);
    if (j.state === "done") return j;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("job did not finish");
}
const req = (over: Record<string, unknown> = {}) => ({ items: [{ user: "acme", name: "app", planHash: hashFor(), ...over }] });

describe("Pm2MoveService.plan", () => {
  it("needs servers:ops, reads the listing (no environment), returns plans without env values", async () => {
    const { svc, access, calls } = setup();
    const r = await svc.plan("u1", "s1", {});
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "servers:ops");
    expect(calls[0].cap).toBe("bulk");
    expect(calls[0].script).not.toContain("--env");
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0]).toMatchObject({ key: "acme/app", status: "ready", image: "node:20" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  it("applies per-process choices (node major, probe path)", async () => {
    const { svc } = setup();
    const r = await svc.plan("u1", "s1", { items: [{ user: "acme", name: "app", nodeMajor: 22, probePath: "/health" }] });
    expect(r.plans[0]).toMatchObject({ image: "node:22", probePath: "/health", nodeSource: "override" });
  });
  it("an outdated agent is a clean 503", async () => {
    const { svc } = setup({ facts: () => `${PM2_BEGIN}\n${PM2_OUTDATED} rc=1\n${PM2_END}` });
    await expect(svc.plan("u1", "s1", {})).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it("404s an unknown server", async () => {
    const { svc, prisma } = setup();
    prisma.server.findUnique.mockResolvedValue(null);
    await expect(svc.plan("u1", "nope", {})).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("Pm2MoveService.start / move", () => {
  it("happy path: app record, owner override on it only, the cutover through the patch capability, settled as moved", async () => {
    const { svc, calls, apps, appUpdate, depUpdate, audit } = setup();
    const j = await done(svc, await svc.start("u1", "s1", req()));
    expect(j.items[0]).toMatchObject({ status: "moved", appId: "app1", pm2Left: false, reason: "ok" });

    expect(apps.create).toHaveBeenCalledTimes(1);
    const dto = apps.create.mock.calls[0][1];
    expect(dto).toMatchObject({ name: "app", serverId: "s1", source: "IMAGE", image: "node:20", containerPort: 3000, exposeMode: "none", deploy: false, tags: ["pm2", "moved"] });
    expect(dto.env).toEqual({ PORT: "3000", DB_PASSWORD: SECRET }); // carried into the encrypted app env
    expect(dto.hostPort).toBeUndefined();

    expect(appUpdate).toHaveBeenCalledWith({
      where: { id: "app1" },
      data: expect.objectContaining({
        dockerOptions: `--network host -u 1001:1001 -w ${CWD} -v ${CWD}:${CWD}`,
        allowPrivilegedDockerOptions: true,
        containerCommand: ["node", `${CWD}/server.js`, "--port", "3000"],
        restartPolicy: "unless-stopped",
        deployStrategy: "RECREATE",
      }),
    });
    expect(apps.buildLocalRunScript).toHaveBeenCalledWith("app1", "dep1");

    // facts (bulk) twice? no: one env read for the move; then the cutover under "patch".
    const cut = calls.find((c) => c.script.includes("run_container"));
    expect(cut?.cap).toBe("patch");
    expect(cut?.script).toContain("tugra_app1:dep1");
    expect(depUpdate).toHaveBeenCalledWith({ where: { id: "dep1" }, data: expect.objectContaining({ status: "SUCCESS", imageTag: "tugra_app1:dep1" }) });
    // The environment is read for the move only, with the narrow flags.
    const envRead = calls.filter((c) => c.script.includes(" --env"));
    expect(envRead).toHaveLength(1);
    expect(envRead[0].script).toContain("'--name=app'");

    // Audit: counts and results, never names or values.
    const logged = JSON.stringify(audit.log.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("DB_PASSWORD");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "pm2.move.start", meta: { processes: 1 } }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "pm2.move", target: "app1" }));
    // Nothing the browser sees carries the environment or the script.
    expect(JSON.stringify(j)).not.toContain(SECRET);
  });

  it("no script ever carries the environment as an argument of the cutover (it rides the Tugra env file transport)", async () => {
    const { svc, calls } = setup();
    await done(svc, await svc.start("u1", "s1", req()));
    for (const c of calls.filter((x) => x.cap !== "bulk")) expect(c.script).not.toContain(SECRET);
  });

  it("moved_pm2_left: moved, flagged so the stopped entry is removed by hand", async () => {
    const { svc } = setup({ move: () => ({ exitCode: 0, output: "TUGRA_PM2MOVE: result=moved_pm2_left reason=delete_failed\n" }) });
    const j = await done(svc, await svc.start("u1", "s1", req()));
    expect(j.items[0]).toMatchObject({ status: "moved", pm2Left: true, reason: "delete_failed" });
  });

  it("rolled back: the app record is dropped, the reason and the app's last output are reported", async () => {
    const { svc, apps } = setup({
      move: () => ({ exitCode: 0, output: "TUGRA_PM2MOVE: step=start\nTUGRA_PM2MOVE_LOG: Error: EADDRINUSE\nTUGRA_PM2MOVE: result=rolled_back reason=not_listening\n" }),
    });
    const j = await done(svc, await svc.start("u1", "s1", req()));
    expect(j.items[0]).toMatchObject({ status: "rolled_back", reason: "not_listening", appId: null, logTail: ["Error: EADDRINUSE"] });
    expect(apps.discardUndeployed).toHaveBeenCalledWith("app1");
  });

  it("aborted before any downtime: record dropped; rollback_failed: record dropped and said loudly", async () => {
    const a = setup({ move: () => ({ exitCode: 0, output: "TUGRA_PM2MOVE: result=aborted reason=pull_failed\n" }) });
    expect((await done(a.svc, await a.svc.start("u1", "s1", req()))).items[0]).toMatchObject({ status: "aborted", reason: "pull_failed" });
    expect(a.apps.discardUndeployed).toHaveBeenCalled();
    const b = setup({ move: () => ({ exitCode: 0, output: "TUGRA_PM2MOVE: result=rollback_failed reason=start_failed\n" }) });
    expect((await done(b.svc, await b.svc.start("u1", "s1", req()))).items[0]).toMatchObject({ status: "rollback_failed" });
  });

  it("unknown outcome (agent dropped mid-move): the recovery runs and decides", async () => {
    const { svc, calls, apps } = setup({
      move: () => new Error("agent connection closed"),
      recover: () => ({ exitCode: 0, output: "TUGRA_PM2MOVE: result=rolled_back reason=recovered\n" }),
    });
    const j = await done(svc, await svc.start("u1", "s1", req()));
    expect(j.items[0]).toMatchObject({ status: "rolled_back", reason: "recovered" });
    expect(calls.filter((c) => c.script.includes('step=recover'))).toHaveLength(1);
    expect(apps.discardUndeployed).toHaveBeenCalled();
  });

  it("recovery finds the move had completed: the live container is kept and reported as moved", async () => {
    const { svc, apps } = setup({ move: () => new Error("timeout"), recover: () => ({ exitCode: 0, output: "TUGRA_PM2MOVE: result=moved reason=recovered\n" }) });
    const j = await done(svc, await svc.start("u1", "s1", req()));
    expect(j.items[0]).toMatchObject({ status: "moved", appId: "app1" });
    expect(apps.discardUndeployed).not.toHaveBeenCalled();
  });

  it("agent gone for the recovery too: unknown, the record is KEPT (a container may be live)", async () => {
    const { svc, apps, depUpdate } = setup({ move: () => new Error("timeout"), recover: () => new Error("agent offline") });
    const j = await done(svc, await svc.start("u1", "s1", req()));
    expect(j.items[0]).toMatchObject({ status: "unknown", reason: "agent_unreachable", appId: "app1" });
    expect(apps.discardUndeployed).not.toHaveBeenCalled();
    // The deployment row is closed (a RUNNING row would block every later deploy of the app).
    expect(depUpdate).toHaveBeenCalledWith({ where: { id: "dep1" }, data: expect.objectContaining({ status: "FAILED" }) });
  });

  it("agent offline before anything was sent: failed, record dropped, no recovery attempt", async () => {
    const { svc, apps, calls } = setup({ move: () => new AgentOfflineException() });
    const j = await done(svc, await svc.start("u1", "s1", req()));
    expect(j.items[0]).toMatchObject({ status: "failed", reason: "agent_offline" });
    expect(apps.discardUndeployed).toHaveBeenCalledWith("app1");
    expect(calls.some((c) => c.script.includes('step=recover'))).toBe(false);
  });

  it("the plan changed since the preview (environment, command, anything): nothing is created or touched", async () => {
    const { svc, apps, calls } = setup();
    const j = await done(svc, await svc.start("u1", "s1", req({ planHash: "0".repeat(64) })));
    expect(j.items[0]).toMatchObject({ status: "plan_changed", reason: "changed" });
    expect(apps.create).not.toHaveBeenCalled();
    expect(calls.some((c) => c.cap === "patch")).toBe(false);
  });

  it("the process vanished or became unsupported since the preview: nothing is created", async () => {
    const gone = setup({ facts: () => doc([]) });
    expect((await done(gone.svc, await gone.svc.start("u1", "s1", req()))).items[0]).toMatchObject({ status: "plan_changed", reason: "gone" });
    const py = setup({ facts: () => doc([factJson({ interpreter: "python3", script: `${CWD}/w.py` }, true)]) });
    const j = await done(py.svc, await py.svc.start("u1", "s1", req({ planHash: hashFor({ interpreter: "python3", script: `${CWD}/w.py` }) })));
    expect(j.items[0]).toMatchObject({ status: "plan_changed", reason: "interpreter" });
    expect(py.apps.create).not.toHaveBeenCalled();
  });

  it("several processes run one after the other; one failing does not stop the next", async () => {
    let n = 0;
    const { svc } = setup({
      facts: () => doc([factJson({}, true), factJson({ name: "b" }, true)]),
      move: () => ({ exitCode: 0, output: ++n === 1 ? "TUGRA_PM2MOVE: result=rolled_back reason=not_listening\n" : "TUGRA_PM2MOVE: result=moved reason=ok\n" }),
    });
    const hb = hashFor({ name: "b" });
    const j = await done(svc, await svc.start("u1", "s1", { items: [{ user: "acme", name: "app", planHash: hashFor() }, { user: "acme", name: "b", planHash: hb }] }));
    expect(j.items.map((i) => i.status)).toEqual(["rolled_back", "moved"]);
  });

  describe("guards", () => {
    it("needs servers:ops AND apps:config", async () => {
      const { svc, access } = setup();
      await done(svc, await svc.start("u1", "s1", req()));
      expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "servers:ops");
      expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:config");
    });
    it("refuses when the patch or deploy capability is revoked on the server", async () => {
      await expect(setup({ caps: ["deploy"] }).svc.start("u1", "s1", req())).rejects.toBeInstanceOf(ForbiddenException);
      await expect(setup({ caps: ["patch"] }).svc.start("u1", "s1", req())).rejects.toBeInstanceOf(ForbiddenException);
    });
    it("one job per server at a time", async () => {
      const { svc } = setup();
      const first = await svc.start("u1", "s1", req());
      await expect(svc.start("u1", "s1", req())).rejects.toBeInstanceOf(ConflictException);
      await done(svc, first);
      await expect(done(svc, await svc.start("u1", "s1", req()))).resolves.toBeDefined();
    });
    it("refuses the same process twice", async () => {
      const { svc } = setup();
      await expect(svc.start("u1", "s1", { items: [...req().items, ...req().items] })).rejects.toBeInstanceOf(BadRequestException);
    });
    it("an environment from another team is refused", async () => {
      const { svc, prisma } = setup();
      prisma.environment.findFirst.mockResolvedValue(null);
      await expect(svc.start("u1", "s1", { ...req(), environmentId: "other" })).rejects.toBeInstanceOf(BadRequestException);
    });
    it("a job is only readable on its own server", async () => {
      const { svc } = setup();
      const j = await svc.start("u1", "s1", req());
      await done(svc, j);
      await expect(svc.getJob("u1", "s1", "nope")).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
