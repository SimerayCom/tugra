import { H, IP, makeRig, zoneRec, type Rig } from "./testing/cutover-rig";
import { TLS_DEADLINE_MS } from "./tls-preissue.handler";
import { HTTP01_GAP_ATTEST, LEFT_OUT_ATTEST } from "./cutover-holds";

afterEach(() => jest.useRealTimers());

const apps = (n: number, hasData = false) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, host: H(i + 1), hasData }));
const zoneFor = (n: number) => Array.from({ length: n }, (_, i) => zoneRec(`r${i + 1}`, H(i + 1)));
const email = (value: string) => ({ acmeEmail: { value, source: "request" as const, setBy: "user1", at: "2026-11-20T09:00:00Z" } });
const darkOk = (rig: Rig, hosts: string[]) => {
  for (const h of hosts) rig.host.dark.set(h, { verify: 0, status: 200, traefik404: false });
};

describe("TLS_PREISSUE (two-box)", () => {
  it("prepares DNS-01 for the covered hosts, redeploys once, and passes when every host is READY with a certificate; no DNS write", async () => {
    const rig = makeRig({ apps: apps(2), zone: zoneFor(2) });
    const r = await rig.driver.drive(rig.handlers.tls);
    expect(r.status).toBe("PASSED");
    expect(rig.prisma.cutoverDomain.rows.map((x) => [x.hostname, x.state, x.challenge, x.certState])).toEqual([[H(1), "READY", "dns01", "ready"], [H(2), "READY", "dns01", "ready"]]);
    expect(rig.appsSvc.setDomainOptions).toHaveBeenCalledWith("user1", "a1", { dnsChallenge: true });
    expect(rig.appsSvc.deploy.mock.calls.map((c) => (c as unknown[])[3])).toEqual(["migrun:run1:tls:a1:0", "migrun:run1:tls:a2:0"]);
    expect(rig.writes).toEqual([]);
    expect(rig.driver.eventCodes()).toContain("tls-preissue.redeploy");
  });

  it("an app is redeployed once however long the certificate takes", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    rig.sim.sslOk = false;
    await rig.driver.drive(rig.handlers.tls, { maxTicks: 6 });
    expect(rig.appsSvc.deploy).toHaveBeenCalledTimes(1);
  });

  it("a certificate that never arrives fails after the deadline (retryable), never earlier", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    rig.sim.sslOk = false;
    const r = await rig.driver.drive(rig.handlers.tls, { maxTicks: 200 });
    expect(r.status).toBe("FAILED");
    expect(r.fail).toMatchObject({ code: "tls-preissue.timeout", retryable: true });
    const started = new Date(rig.driver.rec("TLS_PREISSUE").compensation!.startedAt as string).getTime();
    expect(rig.driver.now.getTime() - started).toBeGreaterThan(TLS_DEADLINE_MS);
  });

  it("without DNS-01 credentials the hosts fall back to HTTP-01, which needs the gap accepted: the run option, or each host by an operator attestation", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    rig.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: "ops@realco.io", bind: "public" } as never);
    rig.sim.sslOk = false;
    // nothing else is progressing, so the step asks the operator PER HOST instead of timing out after 20 minutes
    const asked = await rig.driver.drive(rig.handlers.tls, { maxTicks: 120 });
    expect(asked.status).toBe("WAITING_OPERATOR");
    expect(asked.wait).toMatchObject({ kind: "operator", code: "tls-preissue.http01-gap-hosts", params: { hosts: [H(1)], count: 1 }, attest: [HTTP01_GAP_ATTEST, LEFT_OUT_ATTEST] });
    expect(rig.appsSvc.setDomainOptions).toHaveBeenCalledWith("user1", "a1", { dnsChallenge: false });
    expect(rig.driver.rec("TLS_PREISSUE").compensation).toMatchObject({ gapWaitAt: expect.any(String) });
    // an attestation for ANOTHER host changes nothing
    rig.driver.attest("TLS_PREISSUE", HTTP01_GAP_ATTEST, "other.example.test");
    expect((await rig.driver.tick(rig.handlers.tls, "evidence")).status).toBe("WAITING_OPERATOR");
    rig.driver.attest("TLS_PREISSUE", HTTP01_GAP_ATTEST, H(1));
    const accepted = await rig.driver.drive(rig.handlers.tls);
    expect(accepted.status).toBe("PASSED");
    expect(accepted.gate!.checks.find((c) => c.code === "tls-preissue.http01-gap")).toMatchObject({ status: "warn", subject: H(1) });

    const gap = makeRig({ apps: apps(1), zone: zoneFor(1), options: { acceptHttp01Gap: true } });
    gap.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: "ops@realco.io", bind: "public" } as never);
    gap.sim.sslOk = false;
    const ok = await gap.driver.drive(gap.handlers.tls);
    expect(ok.status).toBe("PASSED");
    expect(ok.gate!.checks.find((c) => c.code === "tls-preissue.http01-gap")).toMatchObject({ status: "warn", subject: H(1) });
  });

  it("a host the operator leaves out is a warning, nothing is prepared for it, and the step passes without it", async () => {
    const rig = makeRig({ apps: apps(2), zone: zoneFor(2) });
    rig.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: "ops@realco.io", bind: "public" } as never);
    rig.sim.sslOk = false;
    const asked = await rig.driver.drive(rig.handlers.tls, { maxTicks: 120 });
    expect(asked.wait).toMatchObject({ code: "tls-preissue.http01-gap-hosts", params: { hosts: [H(1), H(2)] } });
    rig.driver.attest("TLS_PREISSUE", HTTP01_GAP_ATTEST, H(1));
    rig.driver.attest("TLS_PREISSUE", LEFT_OUT_ATTEST, H(2));
    const r = await rig.driver.drive(rig.handlers.tls);
    expect(r.status).toBe("PASSED");
    expect(r.gate!.checks.find((c) => c.subject === H(2))).toMatchObject({ status: "warn", code: "tls-preissue.host-left-out" });
    expect(r.gate!.checks.find((c) => c.subject === H(1))).toMatchObject({ status: "warn", code: "tls-preissue.http01-gap" });
  });

  it("the gap decision does not stall the other hosts: only the HTTP-01 host waits, the DNS-01 host is ready meanwhile", async () => {
    const rig = makeRig({ apps: apps(2), zone: zoneFor(2) });
    // host 2 has no DNS-01 coverage (its zone is not visible to the server credential)
    rig.cf.findZoneForHostname.mockImplementation((async (_t: string, host: string) => {
      if (host === H(2) && rig.prisma.cutoverDomain.rows.length > 0) throw Object.assign(new Error("no zone"), { status: 404 });
      return { zoneId: "z1", zoneName: "example.com" };
    }) as never);
    rig.sim.sslOk = true;
    const r = await rig.driver.drive(rig.handlers.tls, { maxTicks: 40 });
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.wait).toMatchObject({ code: "tls-preissue.http01-gap-hosts", params: { hosts: [H(2)] } });
    expect(rig.prisma.cutoverDomain.rows.find((x) => x.hostname === H(1))).toMatchObject({ state: "READY", certState: "ready" });
  });

  it("a host DNS-01 cannot serve is a failing check naming the reason; the gap acceptance lifts it (per host, after the preparation too)", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    // the server's DNS-01 credential cannot see the zone, although the team credential can
    rig.cf.findZoneForHostname.mockImplementation((async (_t: string, host: string) => {
      if (rig.prisma.cutoverDomain.rows.length === 0) return { zoneId: "z1", zoneName: "example.com" };
      throw Object.assign(new Error("no zone"), { status: 404, host });
    }) as never);
    rig.sim.sslOk = false;
    const r = await rig.driver.drive(rig.handlers.tls, { maxTicks: 3 });
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.wait).toMatchObject({ code: "tls-preissue.http01-gap-hosts", params: { hosts: [H(1)] } });
    expect(rig.prisma.cutoverDomain.rows[0]).toMatchObject({ state: "BLOCKED", blockReason: "zone-not-covered" });
    const gate = await rig.driver.postGateOf(rig.handlers.tls);
    expect(gate.checks.find((c) => c.code === "tls-preissue.dns01-blocked")).toMatchObject({ status: "fail", subject: H(1), params: { reason: "zone-not-covered" } });
    expect(rig.driver.eventCodes()).toContain("tls-preissue.dns01-blocked");
    // the host's gap is accepted AFTER the preparation: it moves to HTTP-01 without redoing the others
    rig.driver.attest("TLS_PREISSUE", HTTP01_GAP_ATTEST, H(1));
    expect((await rig.driver.drive(rig.handlers.tls)).status).toBe("PASSED");
    expect(rig.prisma.cutoverDomain.rows[0]).toMatchObject({ state: "READY", challenge: "http01" });
    expect(rig.driver.rec("TLS_PREISSUE").compensation).toMatchObject({ gapPrepared: [H(1)] });

    const gap = makeRig({ apps: apps(1), zone: zoneFor(1), options: { acceptHttp01Gap: true } });
    gap.cf.findZoneForHostname.mockImplementation((async () => {
      if (gap.prisma.cutoverDomain.rows.length === 0) return { zoneId: "z1", zoneName: "example.com" };
      throw Object.assign(new Error("no zone"), { status: 404 });
    }) as never);
    gap.sim.sslOk = false;
    expect((await gap.driver.drive(gap.handlers.tls)).status).toBe("PASSED");
    expect(gap.prisma.cutoverDomain.rows[0]).toMatchObject({ state: "READY", challenge: "http01" });
  });

  it("a missing ACME email blocks only this step (owner input acmeEmail), and the run's own email is applied when the instance has none", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    rig.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: undefined, bind: "public", dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "x" } } as never);
    rig.world.acmeKnown = false;
    rig.sim.sslOk = false; // the certificates are not there yet, so the step cannot pass on its post gate alone
    const first = await rig.driver.tick(rig.handlers.tls); // init runs before the email can be judged
    expect(first.status).toBe("RUNNING");
    const blocked = await rig.driver.tick(rig.handlers.tls);
    expect(blocked.status).toBe("WAITING_OPERATOR");
    expect(blocked.gate!.checks.find((c) => c.id === "tls-preissue.acme-email")).toMatchObject({ status: "unknown", ownerInput: "acmeEmail" });

    rig.driver.run.inputs = email("ops@realco.io");
    const next = await rig.driver.tick(rig.handlers.tls);
    expect(next.status).toBe("RUNNING");
    expect(rig.world.applied).toEqual(["ops@realco.io"]);
    expect(rig.driver.eventCodes()).toContain("tls-preissue.acme-email-applied");
  });

  it("an existing instance email is never overwritten by the run's input", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1), run: { inputs: email("other@realco.io") } });
    rig.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: undefined, bind: "public", dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "x" } } as never);
    rig.world.acmeKnown = true;
    await rig.driver.drive(rig.handlers.tls, { maxTicks: 3 });
    expect(rig.world.applied).toEqual([]);
  });

  it("seed mode waits for the migrator's certificates, then merges them once", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1), options: { certs: "seed" } });
    let staged = 0;
    rig.prisma.cutoverCert.count = (async ({ where }: { where?: { appliedAt?: unknown } } = {}) => (where?.appliedAt === null ? staged : 0)) as never;
    const waiting = await rig.driver.tick(rig.handlers.tls);
    expect(waiting).toMatchObject({ status: "WAITING_OPERATOR", wait: { kind: "operator", code: "tls-preissue.certs-not-staged" } });
    expect(rig.certs.seed).not.toHaveBeenCalled();
    staged = 2;
    const r = await rig.driver.drive(rig.handlers.tls);
    expect(r.status).toBe("PASSED");
    expect(rig.certs.seed).toHaveBeenCalledTimes(1);
    expect(rig.certs.seed).toHaveBeenCalledWith("user1", "op1", { serverId: "srv1", acknowledgeProxyRestart: true });
  });

  it("seed mode refuses a target that serves other live apps (the proxy restart would drop their ingress)", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1), options: { certs: "seed" } });
    rig.world.otherLive = 2;
    await rig.driver.tick(rig.handlers.tls); // init
    const r = await rig.driver.tick(rig.handlers.tls);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.find((c) => c.id === "tls-preissue.seed-live-apps")).toMatchObject({ status: "fail", params: { count: 2 } });
    expect(rig.certs.seed).not.toHaveBeenCalled();
  });

  it("an op with no hostnames has nothing to issue", async () => {
    const rig = makeRig({ apps: [{ id: "a1", host: "" }] });
    rig.world.apps[0].domain = null;
    expect((await rig.driver.tick(rig.handlers.tls)).status).toBe("PASSED");
    expect(rig.driver.rec("TLS_PREISSUE").attempt).toBe(0);
  });

  it("a retry redoes the preparation and moves the redeploy generation on", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    rig.sim.sslOk = false;
    await rig.driver.drive(rig.handlers.tls, { maxTicks: 3 });
    expect(rig.appsSvc.deploy).toHaveBeenCalledTimes(1);
    await rig.driver.tick(rig.handlers.tls, "retry");
    expect(rig.appsSvc.deploy).toHaveBeenCalledTimes(2);
    expect((rig.appsSvc.deploy.mock.calls[1] as unknown[])[3]).toBe("migrun:run1:tls:a1:1");
  });

  it("abort switches the per-host DNS-01 setting back off for an app that did not have it, and says nothing about a two-box proxy", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    await rig.driver.drive(rig.handlers.tls);
    expect(rig.prisma.__apps.get("a1")!.dnsChallenge).toBe(true);
    rig.appsSvc.setDomainOptions.mockClear();
    expect(await rig.driver.compensate(rig.handlers.tls, "abort")).toEqual({ outcome: "done" });
    expect(rig.appsSvc.setDomainOptions).toHaveBeenCalledWith("user1", "a1", { dnsChallenge: false });
    expect(await rig.driver.compensate(rig.handlers.tls, "cleanup")).toEqual({ outcome: "nothing-to-do" });
    expect(await rig.driver.compensate(rig.handlers.tls, "reverse")).toEqual({ outcome: "nothing-to-do" });
  });

  it("dry run writes nothing: no cutover row, no app setting, no deploy; an unknown ACME email would block the real run", async () => {
    const rig = makeRig({ apps: apps(2), zone: zoneFor(2), run: { dryRun: true } });
    rig.world.acmeKnown = false;
    await rig.driver.tick(rig.handlers.tls);
    const items = rig.driver.rec("TLS_PREISSUE").progress!.dryRun!;
    expect(items.map((i) => i.code)).toEqual(["tls-preissue.dry.mode", "tls-preissue.dry.hosts", "tls-preissue.acme-email"]);
    expect(items[2].level).toBe("unknown");
    expect(rig.prisma.cutoverDomain.rows).toHaveLength(0);
    expect(rig.appsSvc.setDomainOptions).not.toHaveBeenCalled();
    expect(rig.appsSvc.deploy).not.toHaveBeenCalled();
    expect(rig.writes).toEqual([]);
  });
});

describe("TLS_PREISSUE (swap-proxy, dark phase)", () => {
  const swap = (o: Parameters<typeof makeRig>[0] = {}) => {
    const rig = makeRig({ apps: apps(2), zone: zoneFor(2), ...o, run: { topology: "swap-proxy", mode: "takeover", ...(o.run ?? {}) } });
    rig.world.server.proxyBind = "none";
    rig.host.tugra = { status: "running", ports: [] };
    return rig;
  };

  it("verifies readiness with the DARK probe against the Tugra proxy, never the cutover check (that would probe Coolify's router)", async () => {
    const rig = swap();
    darkOk(rig, [H(1), H(2)]);
    const check = jest.spyOn(rig.cutover, "check");
    const r = await rig.driver.drive(rig.handlers.tls);
    expect(r.status).toBe("PASSED");
    expect(check).not.toHaveBeenCalled();
    expect(rig.host.log.some((l) => l.kind === "dark-probe")).toBe(true);
    expect(rig.host.log.some((l) => l.kind === "loopback-probe")).toBe(false);
    expect(rig.net.httpAt).not.toHaveBeenCalled();
    expect(rig.writes).toEqual([]);
  });

  it("makes the Tugra proxy dark first (proxyBind none) when it was public, and records what it was", async () => {
    const rig = swap();
    rig.world.server.proxyBind = "public";
    darkOk(rig, [H(1), H(2)]);
    const r = await rig.driver.drive(rig.handlers.tls);
    expect(r.status).toBe("PASSED");
    expect(rig.world.server.proxyBind).toBe("none");
    expect(rig.proxyOps.start).toHaveBeenCalledTimes(1);
    expect(rig.driver.rec("TLS_PREISSUE").compensation).toMatchObject({ bindPrev: "public" });
  });

  it("refuses to restart the proxy for the bind change when other live apps would lose ingress", async () => {
    const rig = swap();
    rig.world.server.proxyBind = "public";
    rig.world.otherLive = 1;
    const r = await rig.driver.drive(rig.handlers.tls);
    expect(r.fail).toMatchObject({ code: "tls-preissue.swap-bind-needs-restart", retryable: true });
    expect(rig.proxyOps.start).not.toHaveBeenCalled();
  });

  it("a host whose certificate does not verify on the dark proxy is not ready (a Traefik default cert fails verification)", async () => {
    const rig = swap();
    darkOk(rig, [H(1)]);
    rig.host.dark.set(H(2), { verify: 21, status: 200, traefik404: false });
    const r = await rig.driver.drive(rig.handlers.tls, { maxTicks: 120 });
    expect(r.fail?.code).toBe("tls-preissue.timeout");
    const gate = await rig.driver.postGateOf(rig.handlers.tls);
    expect(gate.checks.find((c) => c.subject === H(2))).toMatchObject({ status: "fail", code: "tls-preissue.dark-not-ready", params: { tls: "fail", health: "ok" } });
    expect(gate.checks.find((c) => c.subject === H(1))).toMatchObject({ status: "pass" });
  });

  it("HTTP-01 cannot issue while Coolify owns :80: the owner may accept the gap for a healthy host without a certificate", async () => {
    const rig = swap({ options: { acceptHttp01Gap: true } });
    darkOk(rig, [H(1)]);
    rig.host.dark.set(H(2), { verify: 21, status: 200, traefik404: false });
    const r = await rig.driver.drive(rig.handlers.tls);
    expect(r.status).toBe("PASSED");
    expect(r.gate!.checks.find((c) => c.subject === H(2))).toMatchObject({ status: "warn", code: "tls-preissue.http01-gap" });
  });

  it("a Tugra proxy that is not running is a failing dark-probe check, not a pass", async () => {
    const rig = swap();
    rig.host.tugra = { status: "exited", ports: [] };
    await rig.driver.drive(rig.handlers.tls, { maxTicks: 3 });
    const gate = await rig.driver.postGateOf(rig.handlers.tls);
    expect(gate.passed).toBe(false);
    expect(gate.checks.some((c) => c.code === "tls-preissue.dark-probe-no-proxy")).toBe(true);
  });

  it("the abort leaves the bind at none (Coolify still owns :80) and tells the operator", async () => {
    const rig = swap();
    darkOk(rig, [H(1), H(2)]);
    await rig.driver.drive(rig.handlers.tls);
    const r = await rig.driver.compensate(rig.handlers.tls, "abort");
    expect(r.outcome).toBe("manual");
    expect(r.manual).toEqual([{ code: "tls-preissue.bind-left-none" }]);
    expect(rig.world.server.proxyBind).toBe("none");
  });

  it("covers the IP of the box only through the agent: the hub never probes from outside in this step", async () => {
    const rig = swap();
    darkOk(rig, [H(1), H(2)]);
    await rig.driver.drive(rig.handlers.tls);
    expect(rig.net.sslAt).not.toHaveBeenCalled();
    expect(IP).toBe("203.0.113.7");
  });
});

describe("TLS_PREISSUE: review fixes", () => {
  it("the instance-wide ACME email is not written by a run whose actor is not the instance owner; the gate stays unknown until the owner sets it", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    rig.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: undefined, bind: "public", dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "x" } } as never);
    rig.world.acmeKnown = false;
    rig.world.owner = false;
    rig.sim.sslOk = false;
    await rig.driver.tick(rig.handlers.tls); // init
    rig.driver.run.inputs = email("ops@realco.io");
    const blocked = await rig.driver.tick(rig.handlers.tls);
    expect(blocked.status).toBe("WAITING_OPERATOR");
    expect(blocked.gate!.checks.find((c) => c.id === "tls-preissue.acme-email")).toMatchObject({ status: "unknown", ownerInput: "acmeEmail" });
    expect(rig.world.applied).toEqual([]);
    expect(rig.driver.eventCodes()).not.toContain("tls-preissue.acme-email-applied");
  });

  it("when the owner's status changes between the gate and the write, the skipped write is reported once, never applied", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1), run: { inputs: email("ops@realco.io") } });
    rig.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: undefined, bind: "public", dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "x" } } as never);
    rig.world.acmeKnown = false;
    rig.sim.sslOk = false;
    rig.world.owner = false;
    // the observation (before the gate) still saw the owner; the write path re-checks and finds the actor is not one
    const isOwner = jest.spyOn(rig.world, "isInstanceOwner").mockResolvedValueOnce(true).mockResolvedValue(false);
    await rig.driver.tick(rig.handlers.tls);
    await rig.driver.tick(rig.handlers.tls);
    expect(isOwner).toHaveBeenCalled();
    expect(rig.world.applied).toEqual([]);
    expect(rig.driver.eventCodes().filter((c) => c === "tls-preissue.acme-email-owner-only")).toHaveLength(1);
  });

  it("the per-app DNS-01 state recorded first survives a retry: the abort still switches DNS-01 off for an app that did not have it", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    rig.sim.sslOk = false;
    await rig.driver.drive(rig.handlers.tls, { maxTicks: 3 });
    expect(rig.driver.rec("TLS_PREISSUE").compensation!.priorDnsChallenge).toEqual(["a1:0"]);
    expect(rig.prisma.__apps.get("a1")!.dnsChallenge).toBe(true);
    await rig.driver.tick(rig.handlers.tls, "retry"); // the view now shows dns01, which THIS step set
    expect(rig.driver.rec("TLS_PREISSUE").compensation!.priorDnsChallenge).toEqual(["a1:0"]);
    rig.appsSvc.setDomainOptions.mockClear();
    await rig.driver.compensate(rig.handlers.tls, "abort");
    expect(rig.appsSvc.setDomainOptions).toHaveBeenCalledWith("user1", "a1", { dnsChallenge: false });
    expect(rig.prisma.__apps.get("a1")!.dnsChallenge).toBe(false);
  });

  it("the recorded prior state is merged per app (a first-seen app is added, a known one is kept)", async () => {
    const rig = makeRig({ apps: apps(2), zone: zoneFor(2) });
    rig.driver.rec("TLS_PREISSUE").compensation = { priorDnsChallenge: ["a1:0"] };
    rig.sim.sslOk = false;
    await rig.driver.drive(rig.handlers.tls, { maxTicks: 3 });
    expect(rig.driver.rec("TLS_PREISSUE").compensation!.priorDnsChallenge).toEqual(["a1:0", "a2:0"]);
  });

  it("the 20 minutes of polling are counted from the end of the operator's wait for staged certificates, not from the step's start", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1), options: { certs: "seed" } });
    let staged = 0;
    rig.prisma.cutoverCert.count = (async ({ where }: { where?: { appliedAt?: unknown } } = {}) => (where?.appliedAt === null ? staged : 0)) as never;
    rig.sim.sslOk = false;
    expect((await rig.driver.tick(rig.handlers.tls)).status).toBe("WAITING_OPERATOR");
    rig.driver.advance(3 * 3600_000); // the operator took hours to stage the certificates
    staged = 2;
    const r = await rig.driver.tick(rig.handlers.tls, "evidence");
    expect(r.status).toBe("RUNNING");
    expect(rig.certs.seed).toHaveBeenCalledTimes(1);
    expect(rig.driver.rec("TLS_PREISSUE").compensation).toMatchObject({ pollStartedAt: rig.driver.now.toISOString() });
    // the deadline still applies to the polling itself
    const later = await rig.driver.drive(rig.handlers.tls, { maxTicks: 200 });
    expect(later.fail).toMatchObject({ code: "tls-preissue.timeout", retryable: true });
    expect(rig.driver.now.getTime() - new Date(rig.driver.rec("TLS_PREISSUE").compensation!.pollStartedAt as string).getTime()).toBeGreaterThan(TLS_DEADLINE_MS);
  });
});

