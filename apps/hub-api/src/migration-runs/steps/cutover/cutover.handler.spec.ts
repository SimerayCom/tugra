import { Logger } from "@nestjs/common";
import { COOLIFY_ID, H, IP, OLD, SRV, makeRig, zoneRec, type Rig, type RigOpts } from "./testing/cutover-rig";
import { Crash } from "./testing/step-driver";
import { SWAP_VERIFY_DEADLINE_MS, VERIFY_DEADLINE_MS, MANUAL_DNS_ATTEST } from "./cutover.handler";

beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const HASH = "d".repeat(64);
const apps = (n: number, hasData = false) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, host: H(i + 1), hasData }));
const zoneFor = (n: number) => Array.from({ length: n }, (_, i) => zoneRec(`r${i + 1}`, H(i + 1)));

/** A rig whose DNS_PREPARE and TLS_PREISSUE already passed (two-box): every host READY, VERIFY approved for 3 h. */
async function twoBoxReady(o: RigOpts & { n?: number; hasData?: boolean } = {}): Promise<Rig> {
  const n = o.n ?? 2;
  const rig = makeRig({ apps: o.apps ?? apps(n, o.hasData), zone: o.zone ?? zoneFor(n), ...o });
  expect((await rig.driver.drive(rig.handlers.dns)).status).toBe("PASSED");
  expect((await rig.driver.drive(rig.handlers.tls)).status).toBe("PASSED");
  approveVerify(rig);
  rig.phase.current = "cutover";
  return rig;
}

function approveVerify(rig: Rig, over: { acceptDataRisk?: boolean; expiresInMs?: number | null } = {}) {
  rig.driver.setStep("VERIFY", { status: "PASSED" });
  rig.driver.approve("VERIFY", HASH, {
    acceptDataRisk: over.acceptDataRisk ?? true,
    expiresAt: over.expiresInMs === null ? null : new Date(rig.driver.now.getTime() + (over.expiresInMs ?? 3 * 3600_000)).toISOString(),
  });
}

const drive = (rig: Rig, o: { maxTicks?: number } = {}) => rig.driver.drive(rig.handlers.cut, { ...o, between: () => rig.cutover.idle() });
const states = (rig: Rig) => rig.prisma.cutoverDomain.rows.map((r) => [r.hostname, r.state]);
const cutoverWrites = (rig: Rig) => rig.writes.filter((w) => w.phase === "cutover");

describe("CUTOVER two-box: gates", () => {
  it("waits for the TTL window (a timer wait), then flips; nothing is written while waiting", async () => {
    const rig = await twoBoxReady();
    approveVerify(rig, { expiresInMs: null });
    const first = await rig.driver.tick(rig.handlers.cut);
    expect(first.status).toBe("WAITING_TIMER");
    expect(first.wait).toMatchObject({ kind: "timer", code: "cutover.ttl-wait" });
    expect(cutoverWrites(rig)).toEqual([]);
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(states(rig)).toEqual([[H(1), "VERIFIED"], [H(2), "VERIFIED"]]);
  });

  it("ttlPolicy skip-ack does not wait", async () => {
    const rig = await twoBoxReady({ options: { ttlPolicy: "skip-ack" } });
    const first = await rig.driver.tick(rig.handlers.cut);
    expect(first.status).toBe("RUNNING");
    expect(rig.prisma.cutoverRun.rows).toHaveLength(1);
    expect(rig.prisma.cutoverRun.rows[0].params).toMatchObject({ skipTtlWait: true });
  });

  it("needs VERIFY to have passed and its approval to be valid (missing, expired)", async () => {
    const rig = await twoBoxReady({ options: { ttlPolicy: "skip-ack" } });
    rig.driver.setStep("VERIFY", { status: "WAITING_APPROVAL", approval: null });
    let r = await rig.driver.tick(rig.handlers.cut);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.map((c) => c.code)).toEqual(expect.arrayContaining(["cutover.verify-not-passed", "cutover.approval-missing"]));
    approveVerify(rig, { expiresInMs: -1000 });
    r = await rig.driver.tick(rig.handlers.cut);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.find((c) => c.id === "cutover.approval")).toMatchObject({ status: "fail", code: "cutover.approval-expired" });
    expect(cutoverWrites(rig)).toEqual([]);
    expect(rig.driver.run.ponrAt).toBeNull();
  });

  it("a stateful host needs the data-risk acknowledgement from the approval; refused BEFORE the PONR and any write", async () => {
    const rig = await twoBoxReady({ hasData: true, options: { ttlPolicy: "skip-ack" } });
    approveVerify(rig, { acceptDataRisk: false });
    const r = await rig.driver.tick(rig.handlers.cut);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.find((c) => c.id === "cutover.data-risk")).toMatchObject({ status: "fail", params: { hosts: [H(1), H(2)] } });
    expect(rig.driver.run.ponrAt).toBeNull();
    expect(cutoverWrites(rig)).toEqual([]);
  });

  it("an app that depends on a database is stateful for the PONR even after its data task is DONE (CutoverDomain.stateful reads false by then)", async () => {
    const rig = await twoBoxReady({ hasData: true, options: { ttlPolicy: "skip-ack" } });
    expect(rig.prisma.cutoverDomain.rows.every((r) => r.stateful === false)).toBe(true);
    await drive(rig);
    expect(rig.driver.run.ponrAt).not.toBeNull();
  });

  it("without any ready host the gate fails with a code", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    await rig.driver.drive(rig.handlers.dns);
    approveVerify(rig);
    const r = await rig.driver.tick(rig.handlers.cut);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.find((c) => c.id === "cutover.hosts-ready")).toMatchObject({ status: "fail", code: "cutover.no-ready-hosts" });
  });

  it("a placeholder ACME email on the target blocks the step (unknown fails)", async () => {
    const rig = await twoBoxReady({ options: { ttlPolicy: "skip-ack" } });
    rig.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: "admin@example.com", bind: "public", dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "x" } } as never);
    const r = await rig.driver.tick(rig.handlers.cut);
    expect(r.gate!.checks.find((c) => c.id === "cutover.acme-email")).toMatchObject({ status: "unknown", ownerInput: "acmeEmail" });
    expect(cutoverWrites(rig)).toEqual([]);
  });
});

describe("CUTOVER two-box: the point of no return", () => {
  it("a stateless-only run sets no PONR and may auto-revert", async () => {
    const rig = await twoBoxReady({ options: { ttlPolicy: "skip-ack" } });
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(rig.driver.run.ponrAt).toBeNull();
    expect(rig.prisma.cutoverRun.rows[0].params).toMatchObject({ autoRevert: true, stopOnFail: true });
    expect(rig.zone.records.map((x) => [x.name, x.content])).toEqual([[H(1), IP], [H(2), IP]]);
  });

  it("a stateful run persists the PONR before the FIRST provider write, never auto-reverts, and stamps the measured window end", async () => {
    const rig = await twoBoxReady({ hasData: true, options: { ttlPolicy: "skip-ack" } });
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    const w = cutoverWrites(rig);
    expect(w.length).toBeGreaterThan(0);
    expect(w.every((x) => x.ponr)).toBe(true);
    expect(rig.prisma.cutoverRun.rows[0].params).toMatchObject({ autoRevert: false, acceptDataRisk: true });
    expect(rig.driver.eventCodes().filter((c) => c === "run.ponr.reached")).toHaveLength(1);
    expect(rig.driver.run.freezeEndedAt).toBeInstanceOf(Date);
  });

  it("a crash at the PONR boundary (before it is persisted) writes nothing; the resume completes with ONE flip run and the PONR first", async () => {
    const rig = await twoBoxReady({ hasData: true, options: { ttlPolicy: "skip-ack" } });
    rig.driver.onBoundary = (l) => {
      if (l === "ponr" && !rig.driver.run.ponrAt) {
        rig.driver.onBoundary = () => undefined;
        throw new Crash("ponr:before");
      }
    };
    await expect(rig.driver.tick(rig.handlers.cut)).rejects.toBeInstanceOf(Crash);
    expect(cutoverWrites(rig)).toEqual([]);
    expect(rig.driver.run.ponrAt).toBeNull();
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(cutoverWrites(rig).every((x) => x.ponr)).toBe(true);
    expect(rig.prisma.cutoverRun.rows).toHaveLength(1);
  });

  it("a crash after the PONR but before the flip was issued re-enters, plans again and flips once", async () => {
    const rig = await twoBoxReady({ hasData: true, options: { ttlPolicy: "skip-ack" } });
    rig.driver.onBoundary = (l) => {
      if (l === "lease:CUTOVER") {
        rig.driver.onBoundary = () => undefined;
        throw new Crash("lease:after-ponr");
      }
    };
    await expect(rig.driver.tick(rig.handlers.cut)).rejects.toBeInstanceOf(Crash);
    expect(rig.driver.run.ponrAt).not.toBeNull();
    expect(cutoverWrites(rig)).toEqual([]);
    expect((await drive(rig)).status).toBe("PASSED");
    expect(rig.prisma.cutoverRun.rows).toHaveLength(1);
  });

  it("an already-running flip (hub restart mid-flip) is only polled, never started twice", async () => {
    const rig = await twoBoxReady({ hasData: true, options: { ttlPolicy: "skip-ack" } });
    await rig.driver.tick(rig.handlers.cut);
    await rig.cutover.idle();
    const spy = jest.spyOn(rig.cutover, "flip");
    // a fresh "boot" finds the flip half done: one host switching, one still READY, the run row running
    rig.prisma.cutoverDomain.rows[0].state = "SWITCHING";
    rig.prisma.cutoverDomain.rows[1].state = "READY";
    rig.prisma.cutoverRun.rows[0].status = "running";
    rig.prisma.cutoverRun.rows[0].activeKey = "op1";
    rig.prisma.cutoverRun.rows[0].heartbeatAt = new Date();
    const r = await rig.driver.tick(rig.handlers.cut, "recover");
    expect(r).toMatchObject({ status: "RUNNING", pollAfterMs: 5000 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("the TTL clock running out after the flip began never re-gates a resume (committed work resumes)", async () => {
    const rig = await twoBoxReady({ hasData: true, options: { ttlPolicy: "skip-ack" } });
    await rig.driver.tick(rig.handlers.cut);
    await rig.cutover.idle();
    approveVerify(rig, { expiresInMs: -60_000 });
    expect((await drive(rig)).status).toBe("PASSED");
  });
});

describe("CUTOVER two-box: failures", () => {
  it("a failed verification halts the run: the step fails (retryable) without restarting the flip; a retry re-verifies to PASSED once DNS agrees", async () => {
    const rig = await twoBoxReady({ hasData: true, options: { ttlPolicy: "skip-ack" } });
    rig.sim.propagated = false;
    const r = await drive(rig, { maxTicks: 4 });
    expect(r.status).toBe("FAILED");
    expect(r.fail).toMatchObject({ code: "cutover.flip-halted", retryable: true });
    const runs = rig.prisma.cutoverRun.rows.length;
    expect(states(rig).every(([, s]) => s === "VERIFY_FAILED")).toBe(true);
    rig.sim.propagated = true;
    const again = await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() });
    // the retry trigger is what lets a halted run continue
    expect(again.status).toBe("FAILED");
    const retried = await (async () => {
      let t = await rig.driver.tick(rig.handlers.cut, "retry");
      for (let i = 0; i < 6 && t.status === "RUNNING"; i++) {
        rig.driver.advance(30_000);
        t = await rig.driver.tick(rig.handlers.cut, "tick");
      }
      return t;
    })();
    expect(retried.status).toBe("PASSED");
    expect(states(rig).every(([, s]) => s === "VERIFIED")).toBe(true);
    expect(rig.prisma.cutoverRun.rows).toHaveLength(runs);
  });

  it("hosts that stay unverified past the deadline fail with a code", async () => {
    const rig = await twoBoxReady({ options: { ttlPolicy: "skip-ack" } });
    await rig.driver.tick(rig.handlers.cut);
    await rig.cutover.idle();
    for (const r of rig.prisma.cutoverDomain.rows) r.state = "SWITCHED";
    rig.sim.propagated = false;
    rig.prisma.cutoverRun.rows[0].status = "done";
    const res = await rig.driver.drive(rig.handlers.cut, { maxTicks: 200 });
    expect(res.status).toBe("FAILED");
    expect(res.fail).toMatchObject({ code: "cutover.host-not-verified", retryable: true });
    expect(rig.driver.now.getTime() - new Date(rig.driver.rec("CUTOVER").compensation!.flipStartedAt as string).getTime()).toBeGreaterThan(VERIFY_DEADLINE_MS);
  });

  it("a provider-drift CONFLICT host fails the step (a human decides), it is never overwritten", async () => {
    const rig = await twoBoxReady({ options: { ttlPolicy: "skip-ack" } });
    rig.prisma.cutoverDomain.rows[0].state = "CONFLICT";
    const r = await rig.driver.tick(rig.handlers.cut);
    expect(r.fail).toMatchObject({ code: "cutover.host-conflict", retryable: false, params: { hosts: [H(1)] } });
  });

  it("a flip the cutover service refuses (a gate) becomes a retryable code, not a raw message", async () => {
    const rig = await twoBoxReady({ options: { ttlPolicy: "skip-ack" } });
    jest.spyOn(rig.cutover, "flip").mockRejectedValue(Object.assign(new (require("@nestjs/common").ConflictException)("the plan changed since it was reviewed")));
    const r = await rig.driver.tick(rig.handlers.cut);
    expect(r.fail).toEqual({ code: "cutover.flip-refused", params: {}, retryable: true });
  });

  it("blocked hosts are listed, never flipped, and do not stop the rest", async () => {
    const rig = await twoBoxReady({ n: 3, options: { ttlPolicy: "skip-ack" } });
    rig.prisma.cutoverDomain.rows[2].state = "BLOCKED";
    rig.prisma.cutoverDomain.rows[2].blockReason = "tunnel-routed";
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(r.gate!.checks.find((c) => c.code === "cutover.host-not-cut-over")).toMatchObject({ status: "warn", subject: H(3) });
    expect(rig.zone.records.find((x) => x.name === H(3))!.content).toBe(OLD);
  });
});

describe("CUTOVER two-box: manual-DNS hosts", () => {
  const manualRig = async () => {
    const rig = await twoBoxReady({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: "foo.other.net", hasData: true }], zone: zoneFor(1), options: { ttlPolicy: "skip-ack", acceptHttp01Gap: true } });
    expect(rig.prisma.cutoverDomain.rows.find((r) => r.hostname === "foo.other.net")).toMatchObject({ dnsMode: "manual", state: "READY" });
    return rig;
  };

  it("flips the provider host, sets the PONR before telling the operator to change DNS (stateful), then waits for the attestation", async () => {
    const rig = await manualRig();
    const r = await drive(rig);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.wait).toMatchObject({ kind: "operator", code: "cutover.manual-dns", params: { hosts: ["foo.other.net"] }, attest: [MANUAL_DNS_ATTEST] });
    expect(rig.driver.run.ponrAt).not.toBeNull();
    expect(states(rig)).toEqual([[H(1), "VERIFIED"], ["foo.other.net", "READY"]]);
  });

  it("after the operator's attestation it verifies the host against the public resolvers and passes; never writes the manual host's DNS", async () => {
    const rig = await manualRig();
    await drive(rig);
    rig.driver.attest("CUTOVER", MANUAL_DNS_ATTEST, "foo.other.net");
    const orig = rig.lookup.resolve4.getMockImplementation()!;
    rig.lookup.resolve4.mockImplementation((async (h: string) => (h === "foo.other.net" ? [IP] : orig(h))) as never);
    const r = await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() });
    expect(r.status).toBe("PASSED");
    expect(states(rig)).toEqual([[H(1), "VERIFIED"], ["foo.other.net", "VERIFIED"]]);
    expect(cutoverWrites(rig).every((w) => w.kind === "patchDnsRecord" || w.kind === "createDnsRecord")).toBe(true);
    expect(rig.zone.records.some((x) => x.name === "foo.other.net")).toBe(false);
  });

  it("an attested host that never shows up at the target fails after the deadline (retryable)", async () => {
    const rig = await manualRig();
    await drive(rig);
    rig.driver.attest("CUTOVER", MANUAL_DNS_ATTEST);
    const r = await rig.driver.drive(rig.handlers.cut, { maxTicks: 200, between: () => rig.cutover.idle() });
    expect(r.fail).toMatchObject({ code: "cutover.host-not-verified", retryable: true });
  });
});

describe("CUTOVER two-box: compensate", () => {
  it("abort reverts a flipped STATELESS host to the byte-identical records, and is idempotent", async () => {
    const rig = await twoBoxReady({ n: 1, options: { ttlPolicy: "skip-ack" } });
    const before = JSON.stringify(rig.zone.records);
    await drive(rig);
    expect(rig.zone.records[0].content).toBe(IP);
    const r = await rig.driver.compensate(rig.handlers.cut, "abort");
    expect(r.outcome).toBe("done");
    expect(rig.zone.records[0]).toMatchObject({ content: OLD });
    expect(JSON.parse(before)[0]).toMatchObject({ content: OLD });
    expect(states(rig)).toEqual([[H(1), "ROLLED_BACK"]]);
    expect((await rig.driver.compensate(rig.handlers.cut, "abort")).outcome).toBe("nothing-to-do");
  });

  it("abort refuses to revert a host that carries data (the PONR would have been set): code, nothing touched", async () => {
    const rig = await twoBoxReady({ n: 1, hasData: true, options: { ttlPolicy: "skip-ack" } });
    await drive(rig);
    const r = await rig.driver.compensate(rig.handlers.cut, "abort");
    expect(r).toMatchObject({ outcome: "failed", code: "cutover.abort-data-host-flipped", params: { hosts: [H(1)] } });
    expect(rig.zone.records[0].content).toBe(IP);
  });

  it("reverse reverts every flipped host and prints the reverse-sync guidance (nothing syncs backwards)", async () => {
    const rig = await twoBoxReady({ n: 2, hasData: true, options: { ttlPolicy: "skip-ack" } });
    await drive(rig);
    const r = await rig.driver.compensate(rig.handlers.cut, "reverse");
    expect(r.outcome).toBe("manual");
    expect(r.manual).toEqual([{ code: "cutover.reverse-sync-guidance" }]);
    expect(rig.zone.records.map((x) => x.content)).toEqual([OLD, OLD]);
  });

  it("a record that changed after the flip is reported as a conflict (nothing overwritten)", async () => {
    const rig = await twoBoxReady({ n: 1, hasData: true, options: { ttlPolicy: "skip-ack" } });
    await drive(rig);
    rig.zone.records[0].content = "192.0.2.99";
    const r = await rig.driver.compensate(rig.handlers.cut, "reverse");
    expect(r.outcome).toBe("manual");
    expect(r.manual![0]).toMatchObject({ code: "cutover.revert-conflict", params: { hosts: [H(1)] } });
    expect(rig.zone.records[0].content).toBe("192.0.2.99");
  });

  it("a flip still switching cannot be compensated yet (failed, retry later)", async () => {
    const rig = await twoBoxReady({ n: 1, options: { ttlPolicy: "skip-ack" } });
    rig.prisma.cutoverDomain.rows[0].state = "SWITCHING";
    expect(await rig.driver.compensate(rig.handlers.cut, "abort")).toMatchObject({ outcome: "failed", code: "cutover.flip-in-progress" });
  });

  it("cleanup has nothing to undo here", async () => {
    const rig = await twoBoxReady({ n: 1 });
    expect((await rig.driver.compensate(rig.handlers.cut, "cleanup")).outcome).toBe("nothing-to-do");
  });
});

// ───────────────────────────── swap-proxy ─────────────────────────────

const swapRig = async (o: RigOpts & { hasData?: boolean } = {}): Promise<Rig> => {
  const rig = makeRig({ apps: apps(2, o.hasData ?? true), zone: zoneFor(2), ...o, run: { topology: "swap-proxy", mode: "takeover", ...(o.run ?? {}) } });
  rig.world.server.proxyBind = "none";
  rig.host.tugra = { status: "running", ports: [] };
  for (const h of [H(1), H(2)]) rig.host.dark.set(h, { verify: 0, status: 200, traefik404: false });
  expect((await rig.driver.drive(rig.handlers.tls)).status).toBe("PASSED");
  approveVerify(rig);
  rig.phase.current = "cutover";
  return rig;
};
const swapRow = (rig: Rig) => rig.world.swaps.get(`run1|${SRV}`);
const kinds = (rig: Rig) => rig.host.log.map((l) => l.kind);

describe("CUTOVER swap-proxy", () => {
  it("swaps the proxy: identity recorded first, PONR before the source proxy is touched, no DNS write, Coolify stopped with restart=no and never removed", async () => {
    const rig = await swapRig();
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    const stop = rig.host.log.find((l) => l.kind === "swap-stop-source")!;
    expect(stop.ponr).toBe(true);
    expect(kinds(rig).indexOf("swap-inspect")).toBeLessThan(kinds(rig).indexOf("swap-stop-source"));
    expect(swapRow(rig)).toMatchObject({ state: "LIVE", tugraProxyBindBefore: "none", coolifyProxy: { containerId: COOLIFY_ID, image: "traefik:v3.1", restartPolicy: "always", ports: ["80>80/tcp", "443>443/tcp", "8080>8080/tcp"] } });
    expect(rig.host.coolify).toMatchObject({ running: false, restart: "no" });
    expect(rig.host.tugra).toEqual({ status: "running", ports: ["80>80/tcp", "443>443/tcp"] });
    expect(rig.world.server.proxyBind).toBe("public");
    expect(cutoverWrites(rig)).toEqual([]);
    expect(kinds(rig)).not.toContain("swap-reverse");
    expect(rig.driver.run.freezeEndedAt).toBeInstanceOf(Date);
    expect(rig.driver.eventCodes()).toEqual(expect.arrayContaining(["cutover.swap-planned", "cutover.swap-source-stopped", "cutover.swap-live"]));
  });

  it("the cutover check is never used on a swap host (it would probe Coolify's router); hosts are verified from the hub at the box's public IP", async () => {
    const rig = await swapRig();
    const check = jest.spyOn(rig.cutover, "check");
    await drive(rig);
    expect(check).not.toHaveBeenCalled();
    expect(rig.net.sslAt).toHaveBeenCalledWith(IP, H(1));
  });

  it("a stateless-only swap sets no PONR (it can be aborted by reversing)", async () => {
    const rig = await swapRig({ hasData: false });
    expect((await drive(rig)).status).toBe("PASSED");
    expect(rig.driver.run.ponrAt).toBeNull();
    expect(rig.driver.eventCodes()).not.toContain("run.ponr.reached");
  });

  it.each([
    ["a different container name", (rig: Rig) => (rig.host.coolify!.name = "/other-proxy")],
    ["a non-traefik image", (rig: Rig) => (rig.host.coolify!.image = "nginx:1.27")],
    ["a proxy that does not publish :443", (rig: Rig) => (rig.host.coolify!.ports = ["80>80/tcp"])],
    ["no coolify proxy at all", (rig: Rig) => (rig.host.coolify = null)],
  ])("refuses %s: nothing is stopped, no swap row, no PONR", async (_n, mutate) => {
    const rig = await swapRig();
    mutate(rig);
    const r = await drive(rig);
    expect(r.status).toBe("FAILED");
    expect(r.fail).toMatchObject({ code: "cutover.swap-identity-mismatch", retryable: false });
    expect(kinds(rig)).not.toContain("swap-stop-source");
    expect(swapRow(rig)).toBeUndefined();
    expect(rig.driver.run.ponrAt).toBeNull();
  });

  it("an unreadable inspect output is retryable and changes nothing", async () => {
    const rig = await swapRig();
    jest.spyOn(rig.host, "exec").mockReturnValueOnce({ exitCode: 0, output: "TUGRA_SWAP_ID=zzz\n" });
    const r = await drive(rig);
    expect(r.fail).toMatchObject({ code: "cutover.swap-inspect-failed", retryable: true });
    expect(rig.host.coolify!.running).toBe(true);
  });

  it("when the restart policy cannot be set the proxy is NOT stopped (a reboot would undo it); the PONR stays (pessimistic) and a retry finishes", async () => {
    const rig = await swapRig();
    rig.host.updateFails = true;
    const r = await drive(rig);
    expect(r.fail).toMatchObject({ code: "cutover.swap-restart-policy-failed", retryable: true });
    expect(rig.host.coolify!.running).toBe(true);
    expect(rig.driver.run.ponrAt).not.toBeNull();
    expect(swapRow(rig)!.state).toBe("STOPPING_SOURCE_PROXY");
    rig.host.updateFails = false;
    expect((await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() })).status).toBe("PASSED");
    expect(swapRow(rig)!.state).toBe("LIVE");
  });

  it("Coolify restarting its own proxy right away (lab item T1) fails with a code and leaves the swap row at STOPPING", async () => {
    const rig = await swapRig();
    rig.host.coolifyAutoRestarts = true;
    const r = await drive(rig);
    expect(r.fail).toMatchObject({ code: "cutover.swap-source-still-running", retryable: true });
    expect(swapRow(rig)!.state).toBe("STOPPING_SOURCE_PROXY");
    expect(kinds(rig)).not.toContain("swap-reverse");
  });

  it("Coolify coming back before Tugra's proxy starts (it owns :80/:443 again) is detected: the proxy cannot publish the ports", async () => {
    const rig = await swapRig();
    rig.host.coolifyComesBack = true;
    const r = await drive(rig);
    expect(r.fail).toMatchObject({ code: "cutover.swap-ports-not-published", retryable: true });
    expect(swapRow(rig)!.state).toBe("STARTING_TARGET_PROXY");
    expect(rig.driver.eventCodes()).not.toContain("cutover.swap-live");
  });

  it("a failed verification after the swap never reverses on its own: the step fails (retryable), the state stays LIVE, PONR stays", async () => {
    const rig = await swapRig();
    rig.sim.sslOk = false;
    const r = await drive(rig, { maxTicks: 60 });
    expect(r.fail).toMatchObject({ code: "cutover.swap-verify-failed", retryable: true });
    expect(swapRow(rig)!.state).toBe("LIVE");
    expect(rig.driver.run.ponrAt).not.toBeNull();
    expect(kinds(rig)).not.toContain("swap-reverse");
    expect(rig.driver.now.getTime() - swapRow(rig)!.liveAt!.getTime()).toBeGreaterThan(SWAP_VERIFY_DEADLINE_MS);
  });

  it("falls back to the agent's loopback probe (valid after the swap) when the box has no public IP", async () => {
    const rig = await swapRig();
    rig.world.server.publicIp = "10.0.0.5";
    expect((await drive(rig)).status).toBe("PASSED");
    expect(rig.net.sslAt).not.toHaveBeenCalled();
    expect(kinds(rig)).toContain("loopback-probe");
  });

  it("a swap that has no host to move does nothing", async () => {
    const rig = await swapRig();
    for (const r of rig.prisma.cutoverDomain.rows) r.state = "EXCLUDED";
    expect((await rig.driver.tick(rig.handlers.cut)).status).toBe("PASSED");
    expect(kinds(rig)).not.toContain("swap-stop-source");
  });

  it("a reversed swap cannot be swapped again in the same run", async () => {
    const rig = await swapRig();
    await drive(rig);
    await rig.driver.compensate(rig.handlers.cut, "reverse");
    rig.driver.rec("CUTOVER").status = "PENDING";
    rig.host.dark.set(H(1), { verify: 0, status: 200, traefik404: false });
    rig.sim.sslOk = false;
    const r = await rig.driver.tick(rig.handlers.cut, "retry");
    expect(r.fail).toMatchObject({ code: "cutover.swap-reversed", retryable: false });
  });

  describe("reverse and abort", () => {
    it("reverse stops Tugra's proxy, restores the RECORDED restart policy, starts the same container, restores the bind, prints the sync guidance; idempotent", async () => {
      const rig = await swapRig();
      await drive(rig);
      const r = await rig.driver.compensate(rig.handlers.cut, "reverse");
      expect(r).toEqual({ outcome: "done", manual: [{ code: "cutover.reverse-sync-guidance" }] });
      expect(rig.host.coolify).toMatchObject({ running: true, restart: "always", id: COOLIFY_ID });
      expect(rig.host.tugra.status).toBe("exited");
      expect(rig.world.server.proxyBind).toBe("none");
      expect(swapRow(rig)!.state).toBe("REVERSED");
      const again = await rig.driver.compensate(rig.handlers.cut, "reverse");
      expect(again.outcome).toBe("nothing-to-do");
      expect(kinds(rig).filter((k) => k === "swap-reverse")).toHaveLength(1);
    });

    it("abort of a stateless swap reverses it (no sync guidance: nothing was written)", async () => {
      const rig = await swapRig({ hasData: false });
      await drive(rig);
      const r = await rig.driver.compensate(rig.handlers.cut, "abort");
      expect(r).toEqual({ outcome: "done" });
      expect(rig.host.coolify!.running).toBe(true);
    });

    it("compensating before anything was stopped (PLANNED, or no row) touches nothing", async () => {
      const rig = await swapRig();
      expect((await rig.driver.compensate(rig.handlers.cut, "abort")).outcome).toBe("nothing-to-do");
      await rig.world.createSwap("run1", SRV, { containerId: COOLIFY_ID, name: "coolify-proxy", image: "traefik:v3.1", restartPolicy: "always", running: true, ports: ["80>80/tcp", "443>443/tcp"] }, "none");
      expect((await rig.driver.compensate(rig.handlers.cut, "reverse")).outcome).toBe("nothing-to-do");
      expect(kinds(rig)).not.toContain("swap-reverse");
    });

    it("a reverse that cannot confirm the source proxy running is a failure that keeps the REVERSING state for a retry", async () => {
      const rig = await swapRig();
      await drive(rig);
      jest.spyOn(rig.host, "exec").mockReturnValueOnce({ exitCode: 0, output: "TUGRA_SWAP_SOURCE_RUNNING=false\nTUGRA_SWAP_TARGET=exited\n" });
      const r = await rig.driver.compensate(rig.handlers.cut, "reverse");
      expect(r).toMatchObject({ outcome: "failed", code: "cutover.swap-reverse-source-not-running" });
      expect(swapRow(rig)!.state).toBe("REVERSING");
      expect((await rig.driver.compensate(rig.handlers.cut, "reverse")).outcome).toBe("done");
      expect(swapRow(rig)!.state).toBe("REVERSED");
    });
  });

  describe("crash at every boundary", () => {
    const runWithCrash = async (n: number, after: boolean) => {
      const rig = await swapRig();
      rig.world.mutations = 0;
      rig.world.crashAt = { n, after };
      let last: { status: string; fail?: unknown } = { status: "PENDING" };
      for (let boots = 0; boots < 6; boots++) {
        try {
          last = await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() });
          break;
        } catch (e) {
          if (!(e instanceof Crash)) throw e;
          rig.world.crashAt = null; // the "new boot" does not crash again
          rig.driver.rec("CUTOVER").status = "RUNNING";
        }
      }
      return { rig, last };
    };

    it("converges to LIVE with the PONR before the first command that disrupts the source, whatever the crash point", async () => {
      const clean = await swapRig();
      clean.world.mutations = 0;
      await drive(clean);
      const total = clean.world.mutations;
      expect(total).toBeGreaterThanOrEqual(6);
      for (const after of [false, true]) {
        for (let n = 1; n <= total; n++) {
          const { rig, last } = await runWithCrash(n, after);
          const tag = `crash#${n}:${after ? "after" : "before"}`;
          expect({ tag, status: last.status, fail: (last as { fail?: unknown }).fail }).toEqual({ tag, status: "PASSED", fail: undefined });
          expect({ tag, state: swapRow(rig)!.state }).toEqual({ tag, state: "LIVE" });
          expect({ tag, ponr: rig.host.log.filter((l) => l.kind === "swap-stop-source").every((l) => l.ponr) }).toEqual({ tag, ponr: true });
          expect({ tag, reversed: kinds(rig).includes("swap-reverse") }).toEqual({ tag, reversed: false });
          expect({ tag, coolify: rig.host.coolify!.running, restart: rig.host.coolify!.restart }).toEqual({ tag, coolify: false, restart: "no" });
          expect({ tag, ponrEvents: rig.driver.eventCodes().filter((c) => c === "run.ponr.reached").length }).toEqual({ tag, ponrEvents: 1 });
          expect({ tag, stops: kinds(rig).filter((k) => k === "swap-stop-source").length <= 2 }).toEqual({ tag, stops: true });
          expect({ tag, dns: cutoverWrites(rig).length }).toEqual({ tag, dns: 0 });
        }
      }
    });

    it("the source proxy's identity and restart policy are recorded before it is stopped, so a reverse after ANY crash restores it exactly", async () => {
      const clean = await swapRig();
      clean.world.mutations = 0;
      await drive(clean);
      for (let n = 1; n <= clean.world.mutations; n++) {
        const { rig } = await runWithCrash(n, true);
        const r = await rig.driver.compensate(rig.handlers.cut, "reverse");
        expect(["done", "nothing-to-do"]).toContain(r.outcome);
        expect(rig.host.coolify).toMatchObject({ running: true, restart: "always" });
      }
    });
  });
});

describe("CUTOVER dry run", () => {
  it("two-box: projects, writes nothing, never marks the PONR", async () => {
    const rig = makeRig({ apps: apps(2, true), zone: zoneFor(2), run: { dryRun: true } });
    expect((await rig.driver.tick(rig.handlers.cut)).status).toBe("PASSED");
    expect(rig.driver.rec("CUTOVER").progress!.dryRun!.map((i) => i.code)).toEqual(["cutover.dry.mode", "cutover.dry.ponr-will-be-set", "cutover.dry.flip"]);
    expect(rig.writes).toEqual([]);
    expect(rig.driver.run.ponrAt).toBeNull();
  });

  it("swap-proxy: a read-only identity check of the source proxy; a mismatch would block the real run", async () => {
    const rig = makeRig({ apps: apps(1), run: { dryRun: true, topology: "swap-proxy" } });
    await rig.driver.tick(rig.handlers.cut);
    expect(rig.driver.rec("CUTOVER").progress!.dryRun!.map((i) => i.code)).toEqual(["cutover.dry.mode", "cutover.dry.no-ponr", "cutover.dry.swap-identity-ok"]);
    expect(kinds(rig)).toEqual(["swap-inspect"]);
    const bad = makeRig({ apps: apps(1), run: { dryRun: true, topology: "swap-proxy" } });
    bad.host.coolify!.image = "nginx";
    await bad.driver.tick(bad.handlers.cut);
    expect(bad.driver.rec("CUTOVER").progress!.dryRun![2]).toMatchObject({ code: "cutover.dry.swap-identity-mismatch", level: "block" });
  });
});
