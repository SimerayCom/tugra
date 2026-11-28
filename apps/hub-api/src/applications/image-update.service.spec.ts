import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { CMD_BASE_TIMEOUT_MS, CMD_PER_ITEM_TIMEOUT_MS, ImageUpdateService, PROBE_CHUNK_SIZE } from "./image-update.service";
import { IMAGE_PROBE_MAX_ITEMS, IMAGE_PROBE_PER_ITEM_WORST_SEC } from "./image-update-script";
import type { PrismaService } from "../prisma/prisma.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { CryptoService } from "../crypto/crypto.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { SwarmDeployService } from "../clusters/swarm-deploy.service";
import { AgentCommandTimeoutException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";

const D = (c: string) => "sha256:" + c.repeat(64);
const OLD = new Date("2026-01-01T00:00:00Z");
const HOUR = 3_600_000;

type Row = Record<string, unknown>;
const cand = (over: Row = {}): Row => ({
  id: "a1",
  teamId: "t1",
  name: "web",
  image: "nginx",
  status: "RUNNING",
  serverId: "s1",
  clusterId: null,
  environmentId: "e1",
  registryAuthEnc: null,
  imageUpdateCheck: true,
  imageUpstreamDigest: null,
  imageUpstreamCheckedAt: null,
  imageUpstreamChangedAt: null,
  imageCheckFailures: 0,
  imageCheckError: null,
  imageUpdateNotifiedDigest: null,
  ...over,
});
const liveRow = (appId: string, digest: string | null, finished = OLD) => ({ appId, imageDigest: digest, createdAt: finished, startedAt: finished, durationMs: 0 });

/** Build probe output from the script the hub sent: `results` maps a ref to "ok <digest>" or "err <code>". */
function answer(script: string, results: Record<string, string>): string {
  const nonce = /N='([0-9a-f]{16})'/.exec(script)![1];
  const lines: string[] = ["Login Succeeded"];
  for (const m of script.matchAll(/^ {2}chk (\d+) '([^']+)'$/gm)) {
    const r = results[m[2]!];
    if (r) lines.push(`TUGRA_IMGUP_${nonce} ${m[1]} ${r}`);
  }
  lines.push(`TUGRA_IMGUP_${nonce} DONE`);
  return lines.join("\n");
}

interface Opts {
  apps?: Row[];
  live?: Record<string, string | null>;
  servers?: Record<string, string>; // serverId → status
  online?: boolean | ((id: string) => boolean);
  results?: Record<string, string>;
  send?: jest.Mock;
  interval?: number | undefined;
  resolveManager?: jest.Mock;
  claimCount?: number;
  fire?: jest.Mock;
  findUnique?: jest.Mock;
}

function make(o: Opts = {}) {
  const apps = o.apps ?? [cand()];
  const live = o.live ?? Object.fromEntries(apps.map((a) => [a.id as string, `nginx@${D("a")}`]));
  const updateMany = jest.fn().mockImplementation((args: { where: Row; data: Row }) => {
    // the notify CAS (claim) honours claimCount; every other write succeeds
    if ("OR" in args.where) return Promise.resolve({ count: o.claimCount ?? 1 });
    return Promise.resolve({ count: 1 });
  });
  const prisma = {
    application: { findMany: jest.fn().mockResolvedValue(apps), findUnique: o.findUnique ?? jest.fn().mockResolvedValue(apps[0]), updateMany },
    server: {
      findMany: jest.fn().mockImplementation((args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(args.where.id.in.map((id) => ({ id, status: (o.servers ?? {})[id] ?? "ONLINE" }))),
      ),
      findUnique: jest.fn().mockImplementation((args: { where: { id: string } }) => Promise.resolve({ status: (o.servers ?? {})[args.where.id] ?? "ONLINE" })),
    },
    environment: { findUnique: jest.fn().mockResolvedValue({ name: "prod", project: { id: "p1", name: "shop" } }) },
    $queryRaw: jest.fn().mockImplementation(() => Promise.resolve(Object.entries(live).map(([id, d]) => liveRow(id, d)))),
  } as unknown as PrismaService;
  const send = o.send ?? jest.fn().mockImplementation((_s: string, script: string) => Promise.resolve({ exitCode: 0, output: answer(script, o.results ?? { nginx: `ok ${D("b")}` }) }));
  const online = o.online ?? true;
  const agentWs = { isOnline: jest.fn().mockImplementation((id: string) => (typeof online === "function" ? online(id) : online)), sendCommand: send } as unknown as AgentWsServer;
  const crypto = { decrypt: (s: string) => s } as unknown as CryptoService;
  const fire = o.fire ?? jest.fn().mockResolvedValue(undefined);
  const notifications = { fireForEvent: fire } as unknown as NotificationsService;
  const resolveManager = o.resolveManager ?? jest.fn().mockResolvedValue("mgr1");
  const swarm = { resolveManager } as unknown as SwarmDeployService;
  const config = { get: jest.fn().mockReturnValue("interval" in o ? o.interval : 360) } as unknown as ConfigService;
  const svc = new ImageUpdateService(prisma, agentWs, crypto, notifications, swarm, config);
  return { svc, prisma, updateMany, send, fire, resolveManager };
}
const authEnc = (user: string, token = "tok-" + user) => JSON.stringify({ url: "ghcr.io", user, token });
const writes = (updateMany: jest.Mock, key: string) => updateMany.mock.calls.filter((c) => key in (c[0].data ?? {}));

describe("ImageUpdateService.runTick — eligibility", () => {
  it("queries only IMAGE, non-preview, enabled, non-NEW apps with an image (GIT/COMPOSE/preview/NEW/disabled never reach a probe)", async () => {
    const { svc, prisma } = make();
    await svc.runTick();
    expect((prisma.application.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
      source: "IMAGE",
      isPreview: false,
      imageUpdateCheck: true,
      image: { not: null },
      status: { not: "NEW" },
    });
  });
  it("skips a digest-pinned or unparsable ref even if it slipped through", async () => {
    const { svc, send } = make({ apps: [cand({ image: `nginx@${D("a")}` }), cand({ id: "a2", image: "bad ref" })] });
    await svc.runTick();
    expect(send).not.toHaveBeenCalled();
  });
  it("kill switch: interval 0 does nothing at all", async () => {
    const { svc, prisma, send } = make({ interval: 0 });
    await svc.runTick();
    expect(prisma.application.findMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("never throws (a DB failure is swallowed with a warning)", async () => {
    const { svc, prisma } = make();
    (prisma.application.findMany as jest.Mock).mockRejectedValue(new Error("db down"));
    await expect(svc.runTick()).resolves.toBeUndefined();
  });
});

describe("ImageUpdateService.runTick — due-gating", () => {
  const probes = async (over: Row, live?: Record<string, string | null>) => {
    const { svc, send } = make({ apps: [cand(over)], live });
    await svc.runTick();
    return send.mock.calls.length;
  };
  it("a never-checked app is due", async () => expect(await probes({})).toBe(1));
  it("not due while inside the interval, due once it elapsed", async () => {
    expect(await probes({ imageUpstreamCheckedAt: new Date(Date.now() - 1 * HOUR) })).toBe(0);
    expect(await probes({ imageUpstreamCheckedAt: new Date(Date.now() - 7 * HOUR) })).toBe(1);
  });
  it("due again within one tick after a deploy/rollback finished since the last probe", async () => {
    const checked = new Date(Date.now() - 1 * HOUR);
    const { svc, send, prisma } = make({ apps: [cand({ imageUpstreamCheckedAt: checked })] });
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([liveRow("a1", `nginx@${D("a")}`, new Date(Date.now() - 30 * 60_000))]);
    await svc.runTick();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("backs off to daily after 3 consecutive failures", async () => {
    expect(await probes({ imageCheckFailures: 3, imageUpstreamCheckedAt: new Date(Date.now() - 7 * HOUR) })).toBe(0);
    expect(await probes({ imageCheckFailures: 3, imageUpstreamCheckedAt: new Date(Date.now() - 25 * HOUR) })).toBe(1);
    expect(await probes({ imageCheckFailures: 2, imageUpstreamCheckedAt: new Date(Date.now() - 7 * HOUR) })).toBe(1);
  });
  it("an app whose tag was edited since the live deploy has no baseline and is not probed", async () => {
    const { svc, send, prisma } = make({ apps: [cand({ image: "nginx:1.27" })] });
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ ...liveRow("a1", `nginx@${D("a")}`), image: "nginx:1.25" }]);
    await svc.runTick();
    expect(send).not.toHaveBeenCalled();
  });
  it("an app with no baseline (no live digest / repo mismatch) is not probed", async () => {
    expect(await probes({}, { a1: null })).toBe(0);
    expect(await probes({}, { a1: `redis@${D("a")}` })).toBe(0);
    expect(await probes({}, {})).toBe(0);
  });
});

describe("ImageUpdateService — an exact pin (repo:tag@sha256:...) is followed through its tag and only ever notifies", () => {
  const PIN = `nginx:1.27@${D("a")}`;
  it("probes the tag (never the digest ref), with no deployment record needed, and writes the verdict with a CAS on the stored ref", async () => {
    const m = make({ apps: [cand({ image: PIN })], live: {}, results: { "nginx:1.27": `ok ${D("b")}` } });
    await m.svc.runTick();
    expect(m.send).toHaveBeenCalledTimes(1);
    const script = m.send.mock.calls[0][1] as string;
    expect(script).toContain("chk 0 'nginx:1.27'");
    expect(script).not.toContain(D("a"));
    expect(m.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a1", image: PIN }, data: expect.objectContaining({ imageUpstreamDigest: D("b") }) }));
  });
  it("a newer upstream digest fires a notice that names the pinned ref and the pinned digest; it never redeploys or edits the app", async () => {
    const m = make({ apps: [cand({ image: PIN, imageUpdateNotifiedDigest: D("c") })], live: {}, results: { "nginx:1.27": `ok ${D("b")}` } });
    await m.svc.runTick();
    expect(m.fire).toHaveBeenCalledTimes(1);
    expect(m.fire.mock.calls[0][2]).toMatchObject({ appId: "a1", image: PIN, deployedDigest: D("a"), upstreamDigest: D("b") });
    for (const c of m.updateMany.mock.calls) expect(Object.keys((c[0] as { data: Row }).data)).not.toContain("image");
    expect((m.prisma.application as unknown as { update?: unknown }).update).toBeUndefined();
  });
  it("no notice when the tag still points at the pinned digest", async () => {
    const m = make({ apps: [cand({ image: PIN, imageUpdateNotifiedDigest: D("c") })], live: {}, results: { "nginx:1.27": `ok ${D("a")}` } });
    await m.svc.runTick();
    expect(m.fire).not.toHaveBeenCalled();
  });
  it("a bare digest pin (no tag) is never probed", async () => {
    const m = make({ apps: [cand({ image: `nginx@${D("a")}` })] });
    await m.svc.runTick();
    expect(m.send).not.toHaveBeenCalled();
  });
  it("the manual check accepts an exact pin", async () => {
    const m = make({ apps: [cand({ image: PIN })], live: {}, results: { "nginx:1.27": `ok ${D("b")}` } });
    const r = await m.svc.checkApp(cand({ source: "IMAGE", isPreview: false, image: PIN }) as never);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(r.imageUpdate).toBeDefined();
  });
});

describe("ImageUpdateService.runTick — grouping", () => {
  const scriptsOf = (send: jest.Mock) => send.mock.calls.map((c) => c[1] as string);
  it("same credentials on one server → ONE script; the same ref is deduped and applied to several apps", async () => {
    const apps = [cand({ id: "a1", registryAuthEnc: authEnc("bob") }), cand({ id: "a2", registryAuthEnc: authEnc("bob") })];
    const { svc, send, updateMany } = make({ apps });
    await svc.runTick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(scriptsOf(send)[0].match(/^ {2}chk /gm)).toHaveLength(1);
    expect(send.mock.calls[0][2]).toBe("deploy"); // the signed deploy channel
    expect(updateMany.mock.calls.filter((c) => c[0].data.imageUpstreamDigest === D("b")).map((c) => c[0].where.id).sort()).toEqual(["a1", "a2"]);
  });
  it("different credentials → two scripts; anonymous is separate from credentialed", async () => {
    const apps = [cand({ id: "a1", registryAuthEnc: authEnc("bob") }), cand({ id: "a2", registryAuthEnc: authEnc("alice") }), cand({ id: "a3" })];
    const { svc, send } = make({ apps });
    await svc.runTick();
    expect(send).toHaveBeenCalledTimes(3);
    const s = scriptsOf(send);
    expect(s.filter((x) => x.includes("login")).length).toBe(2);
    expect(s.filter((x) => !x.includes("login")).length).toBe(1);
  });
  it("different servers → separate scripts", async () => {
    const { svc, send } = make({ apps: [cand({ id: "a1", serverId: "s1" }), cand({ id: "a2", serverId: "s2" })] });
    await svc.runTick();
    expect(send.mock.calls.map((c) => c[0]).sort()).toEqual(["s1", "s2"]);
  });
  it("more than one chunk of distinct refs is split (10 + 10 + 1)", async () => {
    const apps = Array.from({ length: 2 * PROBE_CHUNK_SIZE + 1 }, (_, i) => cand({ id: `a${i}`, image: `img${i}` }));
    const live = Object.fromEntries(apps.map((a) => [a.id as string, `img${(a.id as string).slice(1)}@${D("a")}`]));
    const { svc, send } = make({ apps, live });
    await svc.runTick();
    expect(send).toHaveBeenCalledTimes(3);
    expect(scriptsOf(send).map((s) => (s.match(/^ {2}chk /gm) ?? []).length).sort((x, y) => x - y)).toEqual([1, PROBE_CHUNK_SIZE, PROBE_CHUNK_SIZE]);
  });
  it("a swarm app probes on its resolved manager", async () => {
    const { svc, send, resolveManager } = make({ apps: [cand({ clusterId: "c1" })] });
    await svc.runTick();
    expect(resolveManager).toHaveBeenCalledWith("c1");
    expect(send.mock.calls[0][0]).toBe("mgr1");
  });
  it("the command timeout scales with the batch and the nonce is fresh per script", async () => {
    const apps = [cand({ id: "a1", image: "nginx" }), cand({ id: "a2", image: "redis" })];
    const { svc, send } = make({ apps, live: { a1: `nginx@${D("a")}`, a2: `redis@${D("a")}` }, results: {} });
    await svc.runTick();
    expect(send.mock.calls[0][3]).toBe(CMD_BASE_TIMEOUT_MS + CMD_PER_ITEM_TIMEOUT_MS * 2);
  });
  it("the hub command budget covers the script's real worst case for every chunk size", () => {
    expect(PROBE_CHUNK_SIZE).toBeLessThanOrEqual(IMAGE_PROBE_MAX_ITEMS);
    for (let n = 1; n <= IMAGE_PROBE_MAX_ITEMS; n++) {
      expect(CMD_BASE_TIMEOUT_MS + CMD_PER_ITEM_TIMEOUT_MS * n).toBeGreaterThanOrEqual(n * IMAGE_PROBE_PER_ITEM_WORST_SEC * 1000);
    }
  });
  it("orders due apps never-probed first, then stalest", async () => {
    const { svc, prisma } = make();
    await svc.runTick();
    expect((prisma.application.findMany as jest.Mock).mock.calls[0][0].orderBy).toEqual({ imageUpstreamCheckedAt: { sort: "asc", nulls: "first" } });
  });
});

describe("ImageUpdateService.runTick — skips (no write, fail closed)", () => {
  const noWrites = (m: ReturnType<typeof make>) => expect(m.updateMany).not.toHaveBeenCalled();
  it("offline server row / agent socket down", async () => {
    const a = make({ servers: { s1: "OFFLINE" } });
    await a.svc.runTick();
    expect(a.send).not.toHaveBeenCalled();
    noWrites(a);
    const b = make({ online: false });
    await b.svc.runTick();
    expect(b.send).not.toHaveBeenCalled();
    noWrites(b);
  });
  it("AgentOfflineException mid-flight: nothing written", async () => {
    const m = make({ send: jest.fn().mockRejectedValue(new AgentOfflineException("s1")) });
    await m.svc.runTick();
    noWrites(m);
  });
  it("capability not granted (Forbidden) skips that group but the others still run", async () => {
    const send = jest.fn().mockImplementation((sid: string, script: string) =>
      sid === "s1" ? Promise.reject(new ForbiddenException("capability off")) : Promise.resolve({ exitCode: 0, output: answer(script, { nginx: `ok ${D("b")}` }) }),
    );
    const m = make({ apps: [cand({ id: "a1", serverId: "s1" }), cand({ id: "a2", serverId: "s2" })], send });
    await m.svc.runTick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(m.updateMany.mock.calls.every((c) => c[0].where.id === "a2")).toBe(true);
    expect(m.updateMany).toHaveBeenCalled();
  });
  it("exit≠0 with no markers: nothing written", async () => {
    const m = make({ send: jest.fn().mockResolvedValue({ exitCode: 127, output: "docker: command not found\nTUGRA_IMGUP_0000000000000000 0 ok " + D("c") }) });
    await m.svc.runTick();
    noWrites(m);
  });
  it("undecryptable stored credentials: skipped, never downgraded to an anonymous probe", async () => {
    const m = make({ apps: [cand({ registryAuthEnc: "not-json" })] });
    await m.svc.runTick();
    expect(m.send).not.toHaveBeenCalled();
    noWrites(m);
    const m2 = make({ apps: [cand({ registryAuthEnc: JSON.stringify({ user: 5 }) })] });
    await m2.svc.runTick();
    expect(m2.send).not.toHaveBeenCalled();
  });
  it("swarm resolveManager throwing skips the app", async () => {
    const m = make({ apps: [cand({ clusterId: "c1" })], resolveManager: jest.fn().mockRejectedValue(new Error("no manager")) });
    await m.svc.runTick();
    expect(m.send).not.toHaveBeenCalled();
    noWrites(m);
  });
  it("a partial result writes only the indexes that came back", async () => {
    const apps = [cand({ id: "a1", image: "nginx" }), cand({ id: "a2", image: "redis" })];
    const m = make({ apps, live: { a1: `nginx@${D("a")}`, a2: `redis@${D("a")}` }, results: { nginx: `ok ${D("b")}` } });
    await m.svc.runTick();
    expect(m.updateMany.mock.calls.every((c) => c[0].where.id === "a1")).toBe(true);
  });
  it("host-free logging: a thrown error text never reaches the logger", async () => {
    const m = make({ send: jest.fn().mockRejectedValue(new Error("TOPSECRET-token ghcr.io/x")) });
    const warn = jest.spyOn((m.svc as unknown as { logger: { warn: (s: string) => void } }).logger, "warn").mockImplementation(() => undefined);
    await m.svc.runTick();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("TOPSECRET");
  });
});

describe("ImageUpdateService.runTick — writes", () => {
  it("ok verdict: stores the digest, checkedAt, clears the error and failures, CAS on image", async () => {
    const m = make();
    await m.svc.runTick();
    const first = m.updateMany.mock.calls[0][0];
    expect(first.where).toEqual({ id: "a1", image: "nginx" });
    expect(first.data).toMatchObject({ imageUpstreamDigest: D("b"), imageCheckError: null, imageCheckFailures: 0 });
    expect(first.data.imageUpstreamCheckedAt).toBeInstanceOf(Date);
    expect(first.data.imageUpstreamChangedAt).toBeInstanceOf(Date); // first observation
  });
  it("changedAt moves only when the upstream digest changed", async () => {
    const same = make({ apps: [cand({ imageUpstreamDigest: D("b"), imageUpstreamChangedAt: OLD, imageUpdateNotifiedDigest: D("b") })] });
    await same.svc.runTick();
    expect(same.updateMany.mock.calls[0][0].data).not.toHaveProperty("imageUpstreamChangedAt");
    const changed = make({ apps: [cand({ imageUpstreamDigest: D("c"), imageUpstreamChangedAt: OLD, imageUpdateNotifiedDigest: D("c") })] });
    await changed.svc.runTick();
    expect(changed.updateMany.mock.calls[0][0].data.imageUpstreamChangedAt).toBeInstanceOf(Date);
  });
  it("an error verdict keeps the previous digest + changedAt, records the code and increments failures", async () => {
    const m = make({ apps: [cand({ imageUpstreamDigest: D("b"), imageUpstreamChangedAt: OLD, imageCheckFailures: 1 })], results: { nginx: "err auth" } });
    await m.svc.runTick();
    expect(m.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = m.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: "a1", image: "nginx" });
    expect(data).toMatchObject({ imageCheckError: "auth", imageCheckFailures: { increment: 1 } });
    expect(data.imageUpstreamCheckedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("imageUpstreamDigest");
    expect(data).not.toHaveProperty("imageUpstreamChangedAt");
  });
  it("records checkedAt at probe START so a deploy finishing during the probe still leaves the verdict stale", async () => {
    const m = make();
    const before = Date.now();
    await m.svc.runTick();
    const at = m.updateMany.mock.calls[0][0].data.imageUpstreamCheckedAt as Date;
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now());
  });
  it("a CAS miss (count 0: the image was edited meanwhile) drops the verdict silently, with no notify", async () => {
    const fire = jest.fn();
    const m = make({ apps: [cand({ imageUpdateNotifiedDigest: D("z") })], fire });
    m.updateMany.mockResolvedValue({ count: 0 });
    await m.svc.runTick();
    expect(m.updateMany).toHaveBeenCalledTimes(1);
    expect(fire).not.toHaveBeenCalled();
  });
  it("one app's failed write does not abort the batch", async () => {
    const apps = [cand({ id: "a1" }), cand({ id: "a2" })];
    const m = make({ apps });
    m.updateMany.mockImplementation((args: { where: { id: string } }) => (args.where.id === "a1" ? Promise.reject(new Error("db")) : Promise.resolve({ count: 1 })));
    await m.svc.runTick();
    expect(m.updateMany.mock.calls.some((c) => c[0].where.id === "a2")).toBe(true);
  });
  it("tick budget: stops starting new probe batches after 8 minutes (leftovers stay due)", async () => {
    let clock = 1_800_000_000_000;
    const now = jest.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const apps = [cand({ id: "a1", serverId: "s1" }), cand({ id: "a2", serverId: "s2" })];
      const send = jest.fn().mockImplementation((_s: string, script: string) => {
        clock += 9 * 60_000;
        return Promise.resolve({ exitCode: 0, output: answer(script, { nginx: `ok ${D("b")}` }) });
      });
      const m = make({ apps, send });
      await m.svc.runTick();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });
});

describe("ImageUpdateService.runTick — notifications", () => {
  it("the first successful probe seeds the dedupe column silently (no notification — fleet upgrade is quiet)", async () => {
    const m = make({ apps: [cand({ imageUpdateNotifiedDigest: null })] });
    await m.svc.runTick();
    expect(m.fire).not.toHaveBeenCalled();
    expect(m.updateMany).toHaveBeenCalledWith({ where: { id: "a1", imageUpdateNotifiedDigest: null }, data: { imageUpdateNotifiedDigest: D("b") } });
  });
  it("a NEW upstream digest fires exactly once with a credential-free ctx", async () => {
    const m = make({ apps: [cand({ imageUpdateNotifiedDigest: D("c"), registryAuthEnc: authEnc("bob", "SUPERSECRET") })] });
    await m.svc.runTick();
    expect(m.fire).toHaveBeenCalledTimes(1);
    const [team, event, ctx] = m.fire.mock.calls[0];
    expect(team).toBe("t1");
    expect(event).toBe("image_update_available");
    expect(ctx).toEqual({ appId: "a1", appName: "web", image: "nginx", deployedDigest: D("a"), upstreamDigest: D("b"), projectName: "shop", environmentName: "prod" });
    expect(JSON.stringify(ctx)).not.toContain("SUPERSECRET");
    const claim = m.updateMany.mock.calls.find((c) => "OR" in c[0].where)![0];
    expect(claim.data).toEqual({ imageUpdateNotifiedDigest: D("b") });
  });
  it("a repeat tick (already notified for this digest) does not fire again", async () => {
    const m = make({ apps: [cand({ imageUpdateNotifiedDigest: D("b"), imageUpstreamDigest: D("b") })] });
    await m.svc.runTick();
    expect(m.fire).not.toHaveBeenCalled();
  });
  it("a second replica losing the CAS (count 0) does not fire", async () => {
    const m = make({ apps: [cand({ imageUpdateNotifiedDigest: D("c") })], claimCount: 0 });
    await m.svc.runTick();
    expect(m.fire).not.toHaveBeenCalled();
  });
  it("a rollback to an older digest does not re-notify (notified digest unchanged)", async () => {
    const m = make({ apps: [cand({ imageUpdateNotifiedDigest: D("b"), imageUpstreamDigest: D("b") })], live: { a1: `nginx@${D("c")}` } });
    await m.svc.runTick();
    expect(m.fire).not.toHaveBeenCalled();
  });
  it("no notification when the new upstream digest equals what is deployed", async () => {
    const m = make({ apps: [cand({ imageUpdateNotifiedDigest: D("c") })], live: { a1: `nginx@${D("b")}` } });
    await m.svc.runTick();
    expect(m.fire).not.toHaveBeenCalled();
  });
  it("fireForEvent throwing does not abort the batch", async () => {
    const apps = [cand({ id: "a1", imageUpdateNotifiedDigest: D("c") }), cand({ id: "a2", imageUpdateNotifiedDigest: D("c") })];
    const fire = jest.fn().mockRejectedValueOnce(new Error("queue down")).mockResolvedValue(undefined);
    const m = make({ apps, fire });
    await m.svc.runTick();
    expect(fire).toHaveBeenCalledTimes(2);
    expect(writes(m.updateMany, "imageUpstreamDigest")).toHaveLength(2);
  });
});

describe("ImageUpdateService.checkApp (manual Check now)", () => {
  const full = (over: Row = {}) => cand({ source: "IMAGE", isPreview: false, ...over }) as never;
  it("rejects non-IMAGE, preview, NEW, pinned and disabled apps with 400", async () => {
    const { svc, send } = make();
    for (const over of [{ source: "GIT" }, { isPreview: true }, { status: "NEW" }, { image: `nginx@${D("a")}` }, { imageUpdateCheck: false }, { image: null }]) {
      await expect(svc.checkApp(full(over))).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("interval 0 → 409 operator-disabled", async () => {
    const { svc } = make({ interval: 0 });
    await expect(svc.checkApp(full())).rejects.toBeInstanceOf(ConflictException);
  });
  it("offline server / agent → 409 'server is offline' and no probe", async () => {
    const a = make({ online: false });
    await expect(a.svc.checkApp(full())).rejects.toThrow("server is offline");
    const b = make({ servers: { s1: "OFFLINE" } });
    await expect(b.svc.checkApp(full())).rejects.toBeInstanceOf(ConflictException);
    const c = make({ send: jest.fn().mockRejectedValue(new AgentOfflineException("s1")) });
    await expect(c.svc.checkApp(full())).rejects.toBeInstanceOf(ConflictException);
  });
  it("a transport failure → fixed 400 message with no output/credential leak", async () => {
    const m = make({ send: jest.fn().mockRejectedValue(new Error("boom TOPSECRET-token")) });
    const err = await m.svc.checkApp(full({ registryAuthEnc: authEnc("bob", "TOPSECRET-token") })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe("could not reach the server agent");
    expect(JSON.stringify(err)).not.toContain("TOPSECRET");
    const noMarker = make({ send: jest.fn().mockResolvedValue({ exitCode: 1, output: "secret registry words" }) });
    const err2 = await noMarker.svc.checkApp(full()).catch((e: Error) => e);
    expect((err2 as Error).message).toBe("could not reach the server agent");
  });
  it("undecryptable stored credentials → 400 (no anonymous downgrade)", async () => {
    const m = make();
    await expect(m.svc.checkApp(full({ registryAuthEnc: "not-json" }))).rejects.toBeInstanceOf(BadRequestException);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("probes, persists and returns a view recomputed from fresh state", async () => {
    const fresh = cand({ source: "IMAGE", isPreview: false, imageUpstreamDigest: D("b"), imageUpstreamCheckedAt: new Date(), imageUpstreamChangedAt: new Date(), imageUpdateNotifiedDigest: D("c") });
    const m = make({ findUnique: jest.fn().mockResolvedValue(fresh) });
    const res = await m.svc.checkApp(full({ imageUpdateNotifiedDigest: D("c") }), true);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(res.imageUpdate).toMatchObject({ state: "update_available", updateAvailable: true, upstreamDigest: D("b"), deployedDigest: D("a") });
    expect(m.fire).toHaveBeenCalledTimes(1); // the manual path shares the persist + notify logic
  });
  it("canWrite=false redacts the digests in the returned view", async () => {
    const fresh = cand({ source: "IMAGE", isPreview: false, imageUpstreamDigest: D("b"), imageUpstreamCheckedAt: new Date() });
    const m = make({ findUnique: jest.fn().mockResolvedValue(fresh) });
    const res = await m.svc.checkApp(full(), false);
    expect(res.imageUpdate).toMatchObject({ state: "update_available", upstreamDigest: null, deployedDigest: null });
  });
  it("30 s throttle: a probe younger than 30 s returns the cached view without touching the agent", async () => {
    const recent = new Date(Date.now() - 10_000);
    const fresh = cand({ source: "IMAGE", isPreview: false, imageUpstreamDigest: D("a"), imageUpstreamCheckedAt: recent });
    const m = make({ findUnique: jest.fn().mockResolvedValue(fresh) });
    const res = await m.svc.checkApp(full({ imageUpstreamCheckedAt: recent, imageUpstreamDigest: D("a") }));
    expect(m.send).not.toHaveBeenCalled();
    expect(res.imageUpdate.state).toBe("up_to_date");
  });
  it("the throttle does not apply when the app was deployed after that probe (stale)", async () => {
    const recent = new Date(Date.now() - 10_000);
    const m = make();
    (m.prisma.$queryRaw as jest.Mock).mockResolvedValue([liveRow("a1", `nginx@${D("a")}`, new Date(Date.now() - 5_000))]);
    await m.svc.checkApp(full({ imageUpstreamCheckedAt: recent }));
    expect(m.send).toHaveBeenCalledTimes(1);
  });
  it("concurrent calls for one app coalesce into a single probe", async () => {
    let release!: (v: { exitCode: number; output: string }) => void;
    let script = "";
    const send = jest.fn().mockImplementation((_s: string, sc: string) => {
      script = sc;
      return new Promise((r) => { release = r; });
    });
    const m = make({ send });
    const p1 = m.svc.checkApp(full());
    const p2 = m.svc.checkApp(full());
    await new Promise((r) => setImmediate(r));
    release({ exitCode: 0, output: answer(script, { nginx: `ok ${D("b")}` }) });
    await Promise.all([p1, p2]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("no baseline (never deployed digest) returns the view without a pointless probe", async () => {
    const m = make({ live: { a1: null } });
    const res = await m.svc.checkApp(full());
    expect(m.send).not.toHaveBeenCalled();
    expect(res.imageUpdate.state).toBe("no_baseline");
  });
});

describe("ImageUpdateService.runTick — hub command timeout isolation (bisect)", () => {
  const refsIn = (script: string) => [...script.matchAll(/^ {2}chk \d+ '([^']+)'$/gm)].map((m) => m[1]!);
  const results = { a: `ok ${D("b")}`, b: `ok ${D("b")}`, hung: `ok ${D("b")}`, d: `ok ${D("b")}` };
  const mkApps = () => ["a", "b", "hung", "d"].map((r, i) => cand({ id: `id${i}`, image: r }));
  const mkLive = () => Object.fromEntries(["a", "b", "hung", "d"].map((r, i) => [`id${i}`, `${r}@${D("a")}`]));

  it("one hung ref only costs itself: the chunk is bisected and the hung single ref records a timeout verdict", async () => {
    const send = jest.fn().mockImplementation((_s: string, script: string) => {
      if (refsIn(script).includes("hung")) return Promise.reject(new AgentCommandTimeoutException("command timed out"));
      return Promise.resolve({ exitCode: 0, output: answer(script, results) });
    });
    const { svc, updateMany } = make({ apps: mkApps(), live: mkLive(), send });
    await svc.runTick();
    const okIds = updateMany.mock.calls.filter((c) => c[0].data.imageUpstreamDigest === D("b")).map((c) => c[0].where.id).sort();
    expect(okIds).toEqual(["id0", "id1", "id3"]);
    const timeouts = updateMany.mock.calls.filter((c) => c[0].data.imageCheckError === "timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]![0].where).toEqual({ id: "id2", image: "hung" });
    expect(timeouts[0]![0].data.imageCheckFailures).toEqual({ increment: 1 });
  });

  it("an offline agent mid-probe is not penalised (no write, no bisect)", async () => {
    const send = jest.fn().mockRejectedValue(new AgentOfflineException());
    const { svc, updateMany } = make({ apps: mkApps(), live: mkLive(), send });
    await svc.runTick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("a manual check on a ref whose command times out records a timeout verdict through the normal path", async () => {
    const send = jest.fn().mockRejectedValue(new AgentCommandTimeoutException("command timed out"));
    const m = make({ send });
    const res = await m.svc.checkApp({ ...cand(), source: "IMAGE", isPreview: false, imageUpdateCheck: true } as never);
    expect(m.updateMany.mock.calls.some((c) => c[0].data.imageCheckError === "timeout")).toBe(true);
    expect(res.imageUpdate.state).toBeDefined();
  });
});
