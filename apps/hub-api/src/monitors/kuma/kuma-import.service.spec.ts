import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { KumaImportService } from "./kuma-import.service";
import { BACKUP } from "./kuma-fixture";

type Body = { name: string; channelIds: string[]; teamId: string };
const bodiesOf = (fn: jest.Mock): Body[] => fn.mock.calls.map((c) => c[1] as Body);

const backupText = JSON.stringify(BACKUP);

function make(opts: { perms?: string[]; servers?: Array<{ id: string; teamId: string }>; sendCommand?: jest.Mock } = {}) {
  const perms = new Set(opts.perms ?? ["monitors", "integrations", "servers:ops"]);
  const access = {
    requirePermission: jest.fn(async (_u: string, _t: string, p: string) => {
      if (!perms.has(p)) throw new ForbiddenException("insufficient permission for this team");
    }),
  };
  const prisma = {
    monitor: { findMany: jest.fn().mockResolvedValue([]) },
    notificationChannel: { findMany: jest.fn().mockResolvedValue([]) },
    server: { findFirst: jest.fn(async ({ where }: { where: { id: string; teamId: string } }) => (opts.servers ?? []).find((s) => s.id === where.id && s.teamId === where.teamId) ?? null) },
  };
  const audit = { log: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const agentWs = { sendCommand: opts.sendCommand ?? jest.fn() };
  let n = 0;
  const monitors = { create: jest.fn(async (_u: string, _b: unknown) => ({ id: `mon${++n}` })) };
  let c = 0;
  const notifications = { create: jest.fn(async (_u: string, _b: unknown) => ({ id: `chan${++c}` })) };
  const svc = new KumaImportService(prisma as never, access as never, audit as never, config as never, agentWs as never, monitors as never, notifications as never);
  return { svc, access, prisma, audit, agentWs, monitors, notifications };
}

describe("KumaImportService.preview", () => {
  it("is a dry run: reads the backup, writes nothing, needs the monitors permission", async () => {
    const { svc, access, monitors, notifications } = make();
    const plan = await svc.preview("u1", { teamId: "t1", source: { kind: "backup", json: backupText } });
    expect(plan.totals.create).toBe(8);
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "monitors");
    expect(monitors.create).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
    expect(JSON.stringify(plan)).not.toContain("s3cr3t");
  });

  it("checks existing monitors and channels of THIS team only", async () => {
    const { svc, prisma } = make();
    await svc.preview("u1", { teamId: "t1", source: { kind: "backup", json: backupText } });
    expect(prisma.monitor.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: "t1" } }));
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: "t1" } }));
  });

  it("refuses a caller without the monitors permission before reading anything", async () => {
    const { svc, prisma } = make({ perms: [] });
    await expect(svc.preview("u1", { teamId: "t1", source: { kind: "backup", json: backupText } })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.monitor.findMany).not.toHaveBeenCalled();
  });

  it("rejects a file that is not a Kuma backup with a typed 400", async () => {
    const { svc } = make();
    const err = await svc.preview("u1", { teamId: "t1", source: { kind: "backup", json: '{"hello":1}' } }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: "not_kuma" });
  });
});

describe("KumaImportService.apply", () => {
  const source = { kind: "backup" as const, json: backupText };

  it("creates only the confirmed channels and links monitors to them", async () => {
    const { svc, monitors, notifications } = make();
    const res = await svc.apply("u1", { teamId: "t1", source, createChannelRefs: ["1" /* not creatable? it is */, "2"] });
    // refs 1 (telegram) and 2 (webhook) are both new in an empty team
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith("u1", expect.objectContaining({ teamId: "t1", type: "telegram", config: expect.objectContaining({ botToken: "123:abc" }) }));
    expect(res.channels.filter((c) => c.status === "created")).toHaveLength(2);
    expect(res.channels.find((c) => c.ref === "4")!.status).toBe("skipped"); // smtp was not confirmed
    const website = bodiesOf(monitors.create).find((b) => b.name === "Website")!;
    expect(website.teamId).toBe("t1");
    expect(website.channelIds).toHaveLength(2); // telegram + webhook; the PagerDuty link has no Tugra channel
    const pg = bodiesOf(monitors.create).find((b) => b.name === "Postgres")!;
    expect(pg.channelIds).toEqual([]); // smtp not confirmed -> imported without that link
  });

  it("creates no channel when none were confirmed", async () => {
    const { svc, notifications, access } = make({ perms: ["monitors"] });
    const res = await svc.apply("u1", { teamId: "t1", source });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(res.totals.monitorsCreated).toBe(8);
    expect(access.requirePermission).not.toHaveBeenCalledWith("u1", "t1", "integrations");
  });

  it("needs the integrations permission to create channels, and fails before writing anything", async () => {
    const { svc, monitors } = make({ perms: ["monitors"] });
    await expect(svc.apply("u1", { teamId: "t1", source, createChannelRefs: ["1"] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(monitors.create).not.toHaveBeenCalled();
  });

  it("imports only the selected monitors", async () => {
    const { svc, monitors } = make();
    const res = await svc.apply("u1", { teamId: "t1", source, monitorRefs: ["10", "13"] });
    expect(monitors.create).toHaveBeenCalledTimes(2);
    expect(res.monitors.filter((m) => m.status === "skipped").length).toBe(6);
  });

  it("does not create a monitor that already exists, and reports a failed create without stopping", async () => {
    const { svc, prisma, monitors, audit } = make();
    prisma.monitor.findMany.mockResolvedValue([{ name: "Website", type: "HTTP", target: "https://example.com" }]);
    monitors.create.mockRejectedValueOnce(new ForbiddenException("insufficient permission for this team"));
    const res = await svc.apply("u1", { teamId: "t1", source });
    expect(res.monitors.find((m) => m.ref === "10")!.status).toBe("exists");
    expect(res.totals.monitorsFailed).toBe(1);
    expect(res.totals.monitorsCreated).toBe(6);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "monitor.import.kuma", target: "t1" }));
  });

  it("reuses an existing channel without needing the integrations permission", async () => {
    const { svc, prisma, monitors, notifications } = make({ perms: ["monitors"] });
    prisma.notificationChannel.findMany.mockResolvedValue([{ id: "existing", name: "Ops chat", type: "telegram" }]);
    await svc.apply("u1", { teamId: "t1", source });
    expect(notifications.create).not.toHaveBeenCalled();
    const website = bodiesOf(monitors.create).find((b) => b.name === "Website")!;
    expect(website.channelIds).toEqual(["existing"]);
  });

  it("records a channel the notification service refused (e.g. a private host) and still imports the monitors", async () => {
    const { svc, notifications, monitors } = make();
    notifications.create.mockRejectedValueOnce(new BadRequestException("private address not allowed"));
    const res = await svc.apply("u1", { teamId: "t1", source, createChannelRefs: ["1"] });
    expect(res.channels.find((c) => c.ref === "1")).toMatchObject({ status: "failed", error: "private address not allowed" });
    expect(monitors.create).toHaveBeenCalled();
  });
});

describe("KumaImportService — server source", () => {
  const dumpOutput = [
    "TUGRA_KUMA_BEGIN monitor",
    '[{"id":1,"name":"Site","type":"http","url":"https://example.com","interval":60,"active":1}]',
    "TUGRA_KUMA_END monitor",
    "TUGRA_KUMA_BEGIN notification",
    "TUGRA_KUMA_END notification",
    "TUGRA_KUMA_BEGIN link",
    "TUGRA_KUMA_END link",
  ].join("\n");

  it("needs servers:ops and a server of the SAME team, before touching the agent", async () => {
    const sendCommand = jest.fn();
    const noOps = make({ perms: ["monitors"], servers: [{ id: "s1", teamId: "t1" }], sendCommand });
    await expect(noOps.svc.preview("u1", { teamId: "t1", source: { kind: "server", serverId: "s1", container: "kuma" } })).rejects.toBeInstanceOf(ForbiddenException);
    const otherTeam = make({ servers: [{ id: "s1", teamId: "t2" }], sendCommand });
    await expect(otherTeam.svc.preview("u1", { teamId: "t1", source: { kind: "server", serverId: "s1", container: "kuma" } })).rejects.toBeInstanceOf(NotFoundException);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("reads the dump through the agent (streamed chunks) and builds a plan", async () => {
    const sendCommand = jest.fn(async (_s: string, _c: string, _cap: string, _t: number, onChunk?: (c: string) => void) => {
      onChunk?.(dumpOutput.slice(0, 40));
      onChunk?.(dumpOutput.slice(40));
      return { exitCode: 0, output: "truncated…" };
    });
    const { svc } = make({ servers: [{ id: "s1", teamId: "t1" }], sendCommand });
    const plan = await svc.preview("u1", { teamId: "t1", source: { kind: "server", serverId: "s1", container: "kuma" } });
    expect(plan.totals.create).toBe(1);
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("--network none"), "deploy", expect.any(Number), expect.any(Function));
  });

  it("surfaces a typed reason when the Kuma database cannot be read", async () => {
    const sendCommand = jest.fn(async () => ({ exitCode: 0, output: "TUGRA_KUMA_NO_DB" }));
    const { svc } = make({ servers: [{ id: "s1", teamId: "t1" }], sendCommand });
    const err = await svc.preview("u1", { teamId: "t1", source: { kind: "server", serverId: "s1", container: "kuma" } }).catch((e) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: "no_sqlite" });
  });

  it("without a container name, uses the only Kuma on the host and refuses to guess among several", async () => {
    const one = "TUGRA_KUMA|/kuma|louislam/uptime-kuma:1|running|yes";
    const two = one + "\nTUGRA_KUMA|/kuma2|louislam/uptime-kuma:1|running|yes";
    let detectOut = one;
    const sendCommand = jest.fn(async (_s: string, cmd: string) => ({ exitCode: 0, output: cmd.includes("docker run") ? dumpOutput : detectOut }));
    const { svc } = make({ servers: [{ id: "s1", teamId: "t1" }], sendCommand });
    await expect(svc.preview("u1", { teamId: "t1", source: { kind: "server", serverId: "s1" } })).resolves.toBeDefined();
    detectOut = two;
    const err = await svc.preview("u1", { teamId: "t1", source: { kind: "server", serverId: "s1" } }).catch((e) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: "pick_container" });
    detectOut = "";
    await expect(svc.preview("u1", { teamId: "t1", source: { kind: "server", serverId: "s1" } })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("detect lists Kuma containers for the team's server only", async () => {
    const sendCommand = jest.fn(async () => ({ exitCode: 0, output: "TUGRA_KUMA|/kuma|louislam/uptime-kuma:1|running|yes" }));
    const { svc } = make({ servers: [{ id: "s1", teamId: "t1" }], sendCommand });
    await expect(svc.detect("u1", { teamId: "t1", serverId: "s1" })).resolves.toEqual({
      containers: [{ container: "kuma", image: "louislam/uptime-kuma:1", state: "running", hasData: true }],
    });
    await expect(svc.detect("u1", { teamId: "t2", serverId: "s1" })).rejects.toBeInstanceOf(NotFoundException);
  });
});
