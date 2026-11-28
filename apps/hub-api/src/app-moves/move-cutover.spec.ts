import { CUTOVER_COLUMNS, CutoverAckMissing, isValidSnapshot, planCutover, restoreData, type CutoverAppRow, type CutoverServerRow } from "./move-cutover";

const app = (over: Partial<CutoverAppRow> = {}): CutoverAppRow => ({
  id: "capp", name: "blog", serverId: "s1", hostPort: null, domain: null, domainKind: "none", composeFile: null, configMounts: null, templateSlug: null,
  source: "IMAGE", cpusetCpus: null, gpus: null, clusterId: null, allowPrivilegedDockerOptions: false, dockerOptions: null, ...over,
});
const target = (over: Partial<CutoverServerRow> = {}): CutoverServerRow => ({
  id: "s2", publicIp: "5.6.7.8", publicIpv6: null, wildcardDomain: null, magicSuffix: null, proxyBind: "all", cpuCores: 8, gpuInventory: null, ...over,
});
const plan = (a: Partial<CutoverAppRow> = {}, t: Partial<CutoverServerRow> = {}, extra: Record<string, unknown> = {}) =>
  planCutover({ app: app(a), source: { id: "s1", publicIp: "1.2.3.4" }, target: target(t), acks: {}, defaultMagicSuffix: "sslip.io", targetUsedPorts: new Set(), newHostPort: null, ...extra } as never);

describe("planCutover — the normative field table", () => {
  it("a plain app: ONLY serverId changes; everything else is untouched", () => {
    const p = plan();
    expect(p.data).toEqual({ serverId: "s2" });
    expect(p.before).toEqual({ serverId: "s1" });
    expect(p.changes).toEqual({ domain: false, compose: false, cpuset: false, gpus: false, privileged: false });
  });

  it("the exact image is never one of the columns a move changes: the target pulls the very ref the source ran (repo:tag@sha256:...)", () => {
    const image = `nginx:1.27@sha256:${"a".repeat(64)}`;
    const p = plan({ image, hostPort: 8080, domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" } as Partial<CutoverAppRow>, {}, { acks: { domainChanges: true } });
    expect(Object.keys(p.data)).not.toContain("image");
    expect(Object.keys(p.before)).not.toContain("image");
    expect((CUTOVER_COLUMNS as readonly string[]).includes("image")).toBe(false);
  });

  it("hostPort: kept when free; reallocated (with ack) when busy; refused without the ack or without a free port", () => {
    expect(plan({ hostPort: 8080 }).data).toEqual({ serverId: "s2" });
    const used = new Set([8080]);
    expect(() => plan({ hostPort: 8080 }, {}, { targetUsedPorts: used, newHostPort: 20001 })).toThrow(CutoverAckMissing);
    const p = plan({ hostPort: 8080 }, {}, { targetUsedPorts: used, newHostPort: 20001, acks: { hostPortChanged: true } });
    expect(p.data).toEqual({ serverId: "s2", hostPort: 20001 });
    expect(p.before).toEqual({ serverId: "s1", hostPort: 8080 });
    expect(p.needsHostPort).toBe(true);
    expect(() => plan({ hostPort: 8080 }, {}, { targetUsedPorts: used, newHostPort: null, acks: { hostPortChanged: true } })).toThrow(/no free host port/);
  });

  it("magic domain: re-derived with the SAME label for the target's address (ack domainChanges); dropped on a tunnel-only target", () => {
    const a = { domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" };
    expect(() => plan(a)).toThrow(CutoverAckMissing);
    const p = plan(a, {}, { acks: { domainChanges: true } });
    expect(p.data).toEqual({ serverId: "s2", domain: "blog-ab12cd.5-6-7-8.sslip.io" });
    expect(p.before).toEqual({ serverId: "s1", domain: "blog-ab12cd.1-2-3-4.sslip.io" });
    const dropped = plan(a, { proxyBind: "none" }, { acks: { domainChanges: true } });
    expect(dropped.data).toEqual({ serverId: "s2", domain: null, domainKind: "none" });
    expect(dropped.before).toEqual({ serverId: "s1", domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" });
  });

  it("custom domains are never rewritten by the cutover (DNS is the operator's / the DNS step's job)", () => {
    expect(plan({ domain: "blog.example.com", domainKind: "custom" }).data).toEqual({ serverId: "s2" });
  });

  it("template compose / config mounts: self urls are rebased to the target; non-template compose is untouched", () => {
    const composeFile = "services:\n  a:\n    environment:\n      URL: http://blog-ab12cd.1-2-3-4.sslip.io\n      HOST: 1.2.3.4\n";
    const configMounts = [{ target: "/etc/x", content: "listen 1.2.3.4" }];
    const a = { source: "COMPOSE", templateSlug: "wordpress", domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic", composeFile, configMounts };
    const p = plan(a, {}, { acks: { domainChanges: true } });
    expect(p.data.composeFile).toContain("blog-ab12cd.5-6-7-8.sslip.io");
    expect(p.data.composeFile).toContain("HOST: 5.6.7.8");
    expect(p.data.configMounts).toEqual([{ target: "/etc/x", content: "listen 5.6.7.8" }]);
    expect(p.before.composeFile).toBe(composeFile);
    expect(p.before.configMounts).toEqual(configMounts);
    expect(p.changes.compose).toBe(true);
    expect(plan({ ...a, templateSlug: null }, {}, { acks: { domainChanges: true } }).data.composeFile).toBeUndefined();
  });

  it("cpuset / gpus / privileged: dropped only with the matching ack, recorded in the pre-image; refused without it", () => {
    expect(() => plan({ cpusetCpus: "0-15" }, { cpuCores: 4 })).toThrow(CutoverAckMissing);
    const c = plan({ cpusetCpus: "0-15" }, { cpuCores: 4 }, { acks: { resetCpuset: true } });
    expect(c.data).toEqual({ serverId: "s2", cpusetCpus: null });
    expect(c.before).toEqual({ serverId: "s1", cpusetCpus: "0-15" });

    expect(() => plan({ gpus: "all" })).toThrow(CutoverAckMissing);
    const g = plan({ gpus: "all" }, {}, { acks: { dropGpus: true } });
    expect(g.data).toEqual({ serverId: "s2", gpus: null });

    expect(() => plan({ allowPrivilegedDockerOptions: true, dockerOptions: "--privileged" })).toThrow(CutoverAckMissing);
    const pv = plan({ allowPrivilegedDockerOptions: true, dockerOptions: "--privileged" }, {}, { acks: { dropPrivilegedOptions: true } });
    expect(pv.data).toEqual({ serverId: "s2", allowPrivilegedDockerOptions: false, dockerOptions: null });
    expect(pv.before).toEqual({ serverId: "s1", allowPrivilegedDockerOptions: true, dockerOptions: "--privileged" });
  });

  it("the patch can only ever touch the documented columns (never env, certs, webhook, credentials)", () => {
    const p = plan(
      { hostPort: 8080, domain: "b-1.1-2-3-4.sslip.io", domainKind: "magic", cpusetCpus: "0-15", gpus: "all", allowPrivilegedDockerOptions: true, dockerOptions: "--x", source: "COMPOSE", templateSlug: "t", composeFile: "http://b-1.1-2-3-4.sslip.io" },
      { cpuCores: 2 },
      { targetUsedPorts: new Set([8080]), newHostPort: 20001, acks: { hostPortChanged: true, domainChanges: true, resetCpuset: true, dropGpus: true, dropPrivilegedOptions: true } },
    );
    for (const k of Object.keys(p.data)) expect(CUTOVER_COLUMNS as readonly string[]).toContain(k);
    expect(Object.keys(p.before).sort()).toEqual(Object.keys(p.data).sort()); // the pre-image covers exactly what changed
  });
});

describe("restoreData / isValidSnapshot — the cutover is reversible", () => {
  it("restoreData(before) is the exact inverse patch (nulls preserved)", () => {
    const p = plan({ hostPort: 8080, cpusetCpus: "0-15" }, { cpuCores: 4 }, { targetUsedPorts: new Set([8080]), newHostPort: 20001, acks: { hostPortChanged: true, resetCpuset: true } });
    expect(restoreData(p.before)).toEqual({ serverId: "s1", hostPort: 8080, cpusetCpus: "0-15" });
    expect(restoreData({ serverId: "s1", domain: null })).toEqual({ serverId: "s1", domain: null });
  });

  it("round trip: applying data then restoreData returns every changed column to its original value", () => {
    const a = app({ hostPort: 8080, domain: "b-1.1-2-3-4.sslip.io", domainKind: "magic" });
    const p = plan({ hostPort: 8080, domain: "b-1.1-2-3-4.sslip.io", domainKind: "magic" }, {}, { targetUsedPorts: new Set([8080]), newHostPort: 20001, acks: { hostPortChanged: true, domainChanges: true } });
    const moved = { ...a, ...p.data };
    expect(moved.serverId).toBe("s2");
    expect({ ...moved, ...restoreData(p.before) }).toEqual(a);
  });

  it("isValidSnapshot rejects corrupt rows (unknown column, array, missing serverId)", () => {
    expect(isValidSnapshot({ serverId: "s1", hostPort: 1 })).toBe(true);
    expect(isValidSnapshot({ serverId: "s1", envEnc: "x" })).toBe(false);
    expect(isValidSnapshot({ hostPort: 1 })).toBe(false);
    expect(isValidSnapshot([])).toBe(false);
    expect(isValidSnapshot(null)).toBe(false);
  });
});
