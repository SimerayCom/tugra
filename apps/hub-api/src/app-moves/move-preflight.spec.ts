import { APP_MOVE_BLOCKER_CODES, APP_MOVE_WARNING_CODES } from "@tugra/shared";
import { DOCKER_ROOT, MOVE_STAGING_ROOT, type MoveProbe } from "./app-move-scripts";
import {
  assemblePreflight,
  declaredVolumes,
  deriveTargetDomain,
  diskVerdict,
  estimateDowntimeSec,
  partBytesFromEnv,
  pickFreePort,
  type PreflightFacts,
} from "./move-preflight";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const probe = (over: Partial<MoveProbe> = {}, vols: MoveProbe["vols"] = {}): MoveProbe => ({
  df: { [DOCKER_ROOT]: { availKb: 200 * 1024 * 1024, dev: "1" }, [MOVE_STAGING_ROOT]: { availKb: 200 * 1024 * 1024, dev: "2" } },
  tools: { curl: true, split: true, sha256sum: true, gzip: true, helper: true },
  vols,
  ports: new Set([22, 80]),
  hostPaths: {},
  ...over,
});

const server = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  teamId: "t1",
  publicIp: id === "s1" ? "1.2.3.4" : "5.6.7.8",
  publicIpv6: null,
  wildcardDomain: null,
  magicSuffix: null,
  proxyBind: "all",
  cpuCores: 8,
  gpuInventory: null,
  swarmRole: null,
  online: true,
  supportsOriginEnv: true,
  grants: { deploy: true, backup: true },
  ...over,
});

function facts(over: { app?: Record<string, unknown>; source?: Record<string, unknown>; target?: Record<string, unknown>; db?: Record<string, unknown>; [k: string]: unknown } = {}): PreflightFacts {
  const { app, source, target, db, ...rest } = over;
  return {
    app: {
      id: "capp",
      name: "blog",
      teamId: "t1",
      source: "IMAGE",
      serverId: "s1",
      status: "RUNNING",
      clusterId: null,
      isPreview: false,
      adoptedCompose: false,
      dbNetwork: false,
      hostPort: null,
      extraPorts: [],
      portMappings: [],
      containerAlias: null,
      networkAliases: [],
      volumes: [{ name: "data", path: "/data" }],
      composeFile: null,
      configMounts: null,
      isTemplate: false,
      hostMounts: null,
      gpus: null,
      cpusetCpus: null,
      allowPrivilegedDockerOptions: false,
      domain: null,
      domainKind: "none",
      certType: "http",
      tunnelExposed: false,
      hasCustomCert: false,
      pushToRegistry: false,
      buildServerId: null,
      hasCustomDomains: false,
      envKeysReferencingOldHost: [],
      localBackupCount: 0,
      recentDeployMs: [],
      ...app,
    },
    source: server("s1", source),
    target: server("s2", target),
    db: {
      previewPrs: [],
      dbLinkCount: 0,
      rolloutActive: false,
      deployActive: false,
      moveActive: false,
      moveActiveOnServer: false,
      needsAttention: false,
      importActive: false,
      aliasConflict: false,
      networkAliasConflict: false,
      targetReservedPorts: [],
      priorArchiveDockerNames: [],
      targetHasDomainApps: true,
      buildServerOnline: null,
      ...db,
    },
    callerIsOwner: false,
    acks: {},
    sourceProbe: probe({}, { tugra_appv_capp_data: { exists: true, kb: 2048, label: null } }),
    targetProbe: probe(),
    probeFailed: { source: false, target: false },
    link: null,
    partBytes: 256 * MiB,
    hostPortRange: { min: 20000, max: 45000 },
    defaultMagicSuffix: "sslip.io",
    ...rest,
  } as PreflightFacts;
}

const codes = (r: ReturnType<typeof assemblePreflight>) => r.blockers.map((b) => b.code).sort();
const warnCodes = (r: ReturnType<typeof assemblePreflight>) => r.warnings.map((w) => w.code);

describe("assemblePreflight — the happy path", () => {
  it("a healthy running IMAGE app with one small volume is ok, sized from the probe", () => {
    const r = assemblePreflight(facts());
    expect(r.ok).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.requiredAcks).toEqual([]);
    expect(r.plan.cheap).toBe(false);
    expect(r.plan.volumes).toEqual([{ name: "data", dockerName: "tugra_appv_capp_data", kind: "app", sizeBytes: 2048 * 1024, state: "move" }]);
    expect(r.plan.totalBytes).toBe(2048 * 1024);
    expect(r.plan.estimatedParts).toBe(1);
    expect(r.plan.partBytes).toBe(256 * MiB);
    expect(r.plan.estimatedDowntimeSec.low).toBeLessThan(r.plan.estimatedDowntimeSec.high);
    expect(warnCodes(r)).toEqual(expect.arrayContaining(["image_may_differ", "history_splits", "xattrs_acl_not_preserved", "downtime_estimate"]));
  });
});

describe("assemblePreflight — one case per hard blocker", () => {
  const cases: [string, Parameters<typeof facts>[0], string][] = [
    ["same_server", { target: { id: "s1" } }, "same_server"],
    ["cross_team", { target: { teamId: "t2" } }, "cross_team"],
    ["app_is_preview", { app: { isPreview: true } }, "app_is_preview"],
    ["adopted_compose", { app: { adoptedCompose: true } }, "adopted_compose"],
    ["cluster_app", { app: { clusterId: "c1" } }, "cluster_app"],
    ["target_in_cluster", { target: { swarmRole: "WORKER" } }, "target_in_cluster"],
    ["previews_exist", { db: { previewPrs: [3, 7] } }, "previews_exist"],
    ["db_links_exist", { db: { dbLinkCount: 1 } }, "db_links_exist"],
    ["db_network", { app: { dbNetwork: true } }, "db_network"],
    ["rollout_active", { db: { rolloutActive: true } }, "rollout_active"],
    ["deploy_active", { db: { deployActive: true } }, "deploy_active"],
    ["move_active", { db: { moveActive: true } }, "move_active"],
    ["move_active_on_server", { db: { moveActiveOnServer: true } }, "move_active_on_server"],
    ["move_needs_attention", { db: { needsAttention: true } }, "move_needs_attention"],
    ["migration_import_active", { db: { importActive: true } }, "migration_import_active"],
    ["alias_conflict", { db: { aliasConflict: true } }, "alias_conflict"],
    ["network_alias_conflict", { db: { networkAliasConflict: true } }, "network_alias_conflict"],
    ["agent_offline_source", { source: { online: false } }, "agent_offline_source"],
    ["agent_offline_target", { target: { online: false } }, "agent_offline_target"],
    ["agent_too_old", { target: { supportsOriginEnv: false } }, "agent_too_old"],
    ["capability_missing (deploy on target)", { target: { grants: { deploy: false, backup: true } } }, "capability_missing"],
    ["capability_missing (backup on source)", { source: { grants: { deploy: true, backup: false } } }, "capability_missing"],
    ["build_server_offline", { app: { buildServerId: "b1" }, db: { buildServerOnline: false } }, "build_server_offline"],
    ["link_probe_failed", { link: { ok: false, mbps: null, hint: "413" } }, "link_probe_failed"],
    ["privileged_not_owner", { app: { allowPrivilegedDockerOptions: true } }, "privileged_not_owner"],
  ];
  it.each(cases)("%s", (_n, over, code) => {
    const r = assemblePreflight(facts(over));
    expect(codes(r)).toContain(code);
    expect(r.ok).toBe(false);
  });

  it("every hard blocker the assembly can raise is a known, translatable code", () => {
    const seen = new Set(cases.map((c) => c[2]));
    for (const c of seen) expect(APP_MOVE_BLOCKER_CODES).toContain(c);
  });

  it("capability_missing names the offending <serverId>:<cap> subject", () => {
    const r = assemblePreflight(facts({ target: { grants: { deploy: true, backup: false } } }));
    expect(r.blockers.find((b) => b.code === "capability_missing")!.details).toEqual({ subject: "s2:backup" });
  });

  it("agent_too_old mentions the update-first + bootstrapping hint and names the server", () => {
    const r = assemblePreflight(facts({ source: { supportsOriginEnv: false } }));
    const b = r.blockers.find((x) => x.code === "agent_too_old")!;
    expect(b.details).toEqual({ serverId: "s1" });
    expect(b.message).toMatch(/update/i);
    expect(b.message).toMatch(/by hand once/i);
  });
});

describe("assemblePreflight — probe results (fail closed)", () => {
  it("a failed probe on a side is probe_failed, never assumed OK", () => {
    const r = assemblePreflight(facts({ sourceProbe: null, probeFailed: { source: true, target: false } }));
    expect(codes(r)).toContain("probe_failed");
    expect(r.blockers.find((b) => b.code === "probe_failed")!.details).toEqual({ serverId: "s1" });
    expect(r.ok).toBe(false);
  });

  it("an OFFLINE agent is reported as offline only (no duplicate probe_failed)", () => {
    const r = assemblePreflight(facts({ source: { online: false }, sourceProbe: null }));
    expect(codes(r)).toEqual(["agent_offline_source"]);
  });

  it("no_curl and no_tool come from the probe's tool markers", () => {
    const r = assemblePreflight(facts({ targetProbe: probe({ tools: { curl: false, split: true, sha256sum: false, gzip: true, helper: true } }) }));
    expect(codes(r)).toEqual(["no_curl", "no_tool"]);
    expect(r.blockers.find((b) => b.code === "no_tool")!.details).toEqual({ serverId: "s2", tools: ["sha256sum"] });
  });

  it("an existing volume whose size could not be measured is probe_failed (cannot verify disk fit)", () => {
    const r = assemblePreflight(facts({ sourceProbe: probe({}, { tugra_appv_capp_data: { exists: true, kb: null, label: null } }) }));
    expect(codes(r)).toContain("probe_failed");
  });

  it("unreadable df is probe_failed", () => {
    const bad = probe({}, { tugra_appv_capp_data: { exists: true, kb: 1024, label: null } });
    bad.df[MOVE_STAGING_ROOT] = { availKb: null, dev: null };
    const r = assemblePreflight(facts({ sourceProbe: bad }));
    expect(codes(r)).toContain("probe_failed");
  });
});

describe("assemblePreflight — acknowledgement blockers", () => {
  const ackCases: [string, Parameters<typeof facts>[0], string, string][] = [
    ["host_mounts", { app: { hostMounts: [{ hostPath: "/mnt/media", containerPath: "/m" }] } }, "host_mounts", "hostMounts"],
    ["external_volume", { app: { source: "COMPOSE", volumes: [], composeFile: "services:\n  a:\n    image: x\n    volumes:\n      - shared:/d\nvolumes:\n  shared:\n    external: true\n" } }, "external_volume", "externalVolumes"],
    ["gpus_unavailable", { app: { gpus: "all" } }, "gpus_unavailable", "dropGpus"],
    ["cpuset_exceeds", { app: { cpusetCpus: "0-15" }, target: { cpuCores: 4 } }, "cpuset_exceeds", "resetCpuset"],
    ["host_port_changed", { app: { hostPort: 8080 }, db: { targetReservedPorts: [8080] } }, "host_port_changed", "hostPortChanged"],
    ["domain_changes (magic)", { app: { domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" } }, "domain_changes", "domainChanges"],
    ["domain_changes (custom)", { app: { domain: "blog.example.com", domainKind: "custom", certType: "le-http" } }, "domain_changes", "domainChanges"],
  ];
  it.each(ackCases)("%s blocks (ack:true) until acknowledged, then disappears but stays in requiredAcks", (_n, over, code, ack) => {
    const r = assemblePreflight(facts(over));
    const b = r.blockers.find((x) => x.code === code);
    expect(b).toBeDefined();
    expect(b!.ack).toBe(true);
    expect(r.requiredAcks).toContain(ack);
    expect(r.ok).toBe(false);

    const acked = assemblePreflight(facts({ ...over, acks: { [ack]: true } }));
    expect(acked.blockers.find((x) => x.code === code)).toBeUndefined();
    expect(acked.requiredAcks).toContain(ack);
    expect(acked.ok).toBe(true);
  });

  it("privileged options: the INSTANCE OWNER gets an ack; a non-owner is hard-blocked", () => {
    const over = { app: { allowPrivilegedDockerOptions: true } };
    const owner = assemblePreflight(facts({ ...over, callerIsOwner: true }));
    expect(owner.blockers.find((b) => b.code === "privileged_options")?.ack).toBe(true);
    expect(owner.requiredAcks).toContain("dropPrivilegedOptions");
    expect(assemblePreflight(facts({ ...over, callerIsOwner: true, acks: { dropPrivilegedOptions: true } })).ok).toBe(true);
    // acknowledging does not help a non-owner
    const non = assemblePreflight(facts({ ...over, acks: { dropPrivilegedOptions: true } }));
    expect(codes(non)).toEqual(["privileged_not_owner"]);
  });

  it("a gpu request is fine when the target is ready", () => {
    const inv = { v: 1, gpus: [{ index: 0, uuid: null, name: "A", vendor: "nvidia", kind: "gpu", memoryMb: 1, driver: "550.1", pci: null, source: "nvidia-smi" }], runtimes: [], defaultRuntime: null, nvidiaRuntime: true, nvidiaDriverLoaded: true, nvidiaModuleVersion: null, error: null };
    expect(codes(assemblePreflight(facts({ app: { gpus: "all" }, target: { gpuInventory: inv } })))).toEqual([]);
  });

  it("two reasons for domainChanges raise ONE blocker", () => {
    const r = assemblePreflight(facts({ app: { domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic", hasCustomDomains: true } }));
    expect(r.blockers.filter((b) => b.code === "domain_changes")).toHaveLength(1);
  });

  it("a busy host port is reallocated in the plan (to a free port in range) and the new port avoids baked ports", () => {
    const r = assemblePreflight(facts({ app: { hostPort: 20000, extraPorts: [{ hostPort: 20001 }] }, db: { targetReservedPorts: [20000] } }));
    expect(r.plan.hostPort).toEqual({ from: 20000, to: 20002 });
  });
});

describe("assemblePreflight — ports", () => {
  it("extraPorts / compose-baked portMappings colliding on the target are a HARD blocker (never rewritten)", () => {
    const r = assemblePreflight(facts({ app: { extraPorts: [{ hostPort: 9000 }], portMappings: [{ hostPort: 9001 }] }, db: { targetReservedPorts: [9000] }, targetProbe: probe({ ports: new Set([9001]) }) }));
    const b = r.blockers.find((x) => x.code === "ports_conflict")!;
    expect(b.ack).toBeUndefined();
    expect(b.details).toEqual({ ports: [9000, 9001] });
  });

  it("a live listening port from the probe counts as used", () => {
    const r = assemblePreflight(facts({ app: { hostPort: 8080 }, targetProbe: probe({ ports: new Set([8080]) }) }));
    expect(r.requiredAcks).toContain("hostPortChanged");
  });

  it("a free host port is kept", () => {
    const r = assemblePreflight(facts({ app: { hostPort: 8080 } }));
    expect(r.plan.hostPort).toEqual({ from: 8080, to: 8080 });
    expect(r.requiredAcks).toEqual([]);
  });
});

describe("assemblePreflight — volumes", () => {
  it("compose: tugra-owned volumes move, external/named ones are external_skip + ack", () => {
    const composeFile = "services:\n  a:\n    image: x\n    volumes:\n      - data:/d\n      - shared:/s\n      - named:/n\nvolumes:\n  data:\n  shared:\n    external: true\n  named:\n    name: somewhere_else\n";
    const { vols, hasExternal } = declaredVolumes({ id: "capp", source: "COMPOSE", volumes: [], composeFile });
    expect(hasExternal).toBe(true);
    expect(vols.map((v) => [v.name, v.dockerName, v.state])).toEqual([
      ["data", "tugra_capp_data", "move"],
      ["shared", "shared", "external_skip"],
      ["named", "somewhere_else", "external_skip"],
    ]);
  });

  it("a declared volume that does not exist on the source is absent_skip + warning (nothing to move)", () => {
    const r = assemblePreflight(facts({ sourceProbe: probe({}, { tugra_appv_capp_data: { exists: false, kb: null, label: null } }) }));
    expect(r.plan.volumes[0].state).toBe("absent_skip");
    expect(r.plan.totalBytes).toBe(0);
    expect(r.warnings).toContainEqual({ code: "source_volume_absent", details: { volume: "data" } });
    expect(r.ok).toBe(true);
  });

  it("target_volume_exists: a foreign volume with the same name blocks; our own unpurged archive only warns", () => {
    const existsOnTarget = probe({}, { tugra_appv_capp_data: { exists: true, kb: 5, label: null } });
    expect(codes(assemblePreflight(facts({ targetProbe: existsOnTarget })))).toEqual(["target_volume_exists"]);
    const r = assemblePreflight(facts({ targetProbe: existsOnTarget, db: { priorArchiveDockerNames: ["tugra_appv_capp_data"] } }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toContainEqual({ code: "archive_overwritten", details: { volume: "data" } });
  });

  it("bad_volume_name: a volume whose docker name could not be handed to a shell blocks", () => {
    const r = assemblePreflight(facts({ app: { volumes: [{ name: "a b", path: "/x" }] } }));
    expect(codes(r)).toContain("bad_volume_name");
  });
});

describe("assemblePreflight — disk sizing boundaries", () => {
  const big = (kb: number) => probe({}, { tugra_appv_capp_data: { exists: true, kb, label: null } });
  const withFree = (p: MoveProbe, staging: number, docker: number, sameDev: boolean): MoveProbe => ({
    ...p,
    df: { [MOVE_STAGING_ROOT]: { availKb: staging, dev: "5" }, [DOCKER_ROOT]: { availKb: docker, dev: sameDev ? "5" : "6" } },
  });
  const B = 10 * GiB;
  const kb = B / 1024;

  it("same device on the target: needs 2.05*B + 1 GiB", () => {
    const need = Math.ceil((2.05 * B + GiB) / 1024);
    const ok = assemblePreflight(facts({ sourceProbe: big(kb), targetProbe: withFree(probe(), need, need, true) }));
    expect(codes(ok)).toEqual([]);
    const bad = assemblePreflight(facts({ sourceProbe: big(kb), targetProbe: withFree(probe(), need - 1024, need - 1024, true) }));
    expect(codes(bad)).toEqual(["disk_insufficient"]);
  });

  it("separate devices: staging >= 1.02*B + 512MiB and docker root >= 1.05*B + 512MiB", () => {
    const stage = Math.ceil((1.02 * B + 512 * MiB) / 1024);
    const dock = Math.ceil((1.05 * B + 512 * MiB) / 1024);
    expect(codes(assemblePreflight(facts({ sourceProbe: big(kb), targetProbe: withFree(probe(), stage, dock, false) })))).toEqual([]);
    expect(codes(assemblePreflight(facts({ sourceProbe: big(kb), targetProbe: withFree(probe(), stage - 1024, dock, false) })))).toEqual(["disk_insufficient"]);
    expect(codes(assemblePreflight(facts({ sourceProbe: big(kb), targetProbe: withFree(probe(), stage, dock - 1024, false) })))).toEqual(["disk_insufficient"]);
  });

  it("an unknown device id on the target is sized as same-device (the stricter 2.05*B + 1 GiB), never as separate disks", () => {
    const need = Math.ceil((2.05 * B + GiB) / 1024);
    const stage = Math.ceil((1.02 * B + 512 * MiB) / 1024); // enough for separate disks, not for a shared one
    const unknownDock = (kb: number): MoveProbe => ({ ...probe(), df: { [MOVE_STAGING_ROOT]: { availKb: kb, dev: "2049" }, [DOCKER_ROOT]: { availKb: kb, dev: null } } });
    const unknownStage = (kb: number): MoveProbe => ({ ...probe(), df: { [MOVE_STAGING_ROOT]: { availKb: kb, dev: null }, [DOCKER_ROOT]: { availKb: kb, dev: "2049" } } });
    for (const mk of [unknownDock, unknownStage]) {
      expect(codes(assemblePreflight(facts({ sourceProbe: big(kb), targetProbe: mk(stage) })))).toEqual(["disk_insufficient"]);
      expect(codes(assemblePreflight(facts({ sourceProbe: big(kb), targetProbe: mk(need) })))).toEqual([]);
      const r = assemblePreflight(facts({ sourceProbe: big(kb), targetProbe: mk(stage) }));
      expect(r.blockers.find((b) => b.code === "disk_insufficient")!.details).toMatchObject({ targetSameDevice: true });
    }
    // and the lab's real case: one disk (2049) under both → same-device
    const same = assemblePreflight(facts({ sourceProbe: big(kb), targetProbe: { ...probe(), df: { [MOVE_STAGING_ROOT]: { availKb: stage, dev: "2049" }, [DOCKER_ROOT]: { availKb: stage, dev: "2049" } } } }));
    expect(codes(same)).toEqual(["disk_insufficient"]);
  });

  it("the source needs staging >= 1.02*B + 512MiB", () => {
    const srcOk = Math.ceil((1.02 * B + 512 * MiB) / 1024);
    const mk = (free: number) => {
      const s = big(kb);
      s.df = { [MOVE_STAGING_ROOT]: { availKb: free, dev: "2" }, [DOCKER_ROOT]: { availKb: free, dev: "1" } };
      return s;
    };
    const roomy = withFree(probe(), 500 * 1024 * 1024, 500 * 1024 * 1024, false);
    expect(codes(assemblePreflight(facts({ sourceProbe: mk(srcOk), targetProbe: roomy })))).toEqual([]);
    expect(codes(assemblePreflight(facts({ sourceProbe: mk(srcOk - 1024), targetProbe: roomy })))).toEqual(["disk_insufficient"]);
  });

  it("diskVerdict: nothing to move never fails the disk check; unknown free space is flagged unknown", () => {
    expect(diskVerdict({ totalBytes: 0, sourceStagingFreeBytes: 0, targetStagingFreeBytes: 0, targetDockerFreeBytes: 0, targetSameDevice: true }).ok).toBe(true);
    expect(diskVerdict({ totalBytes: 1, sourceStagingFreeBytes: null, targetStagingFreeBytes: 1, targetDockerFreeBytes: 1, targetSameDevice: false })).toMatchObject({ ok: false, unknown: true });
  });
});

describe("assemblePreflight — NEW app (cheap path)", () => {
  const cheap = (over: Parameters<typeof facts>[0] = {}) => facts({ ...over, app: { status: "NEW", ...(over.app ?? {}) }, sourceProbe: null, targetProbe: null });

  it("skips agent probes/capability/version/space checks: offline agents and old agents do not block a NEW app", () => {
    const r = assemblePreflight(cheap({ source: { online: false, supportsOriginEnv: false, grants: { deploy: false, backup: false } }, target: { online: false } }));
    expect(r.ok).toBe(true);
    expect(r.plan.cheap).toBe(true);
    expect(r.plan.volumes.every((v) => v.state === "absent_skip")).toBe(true);
    expect(r.plan.totalBytes).toBe(0);
    expect(r.plan.estimatedDowntimeSec).toEqual({ low: 0, high: 0 });
  });

  it("still runs every DB-fact blocker", () => {
    const r = assemblePreflight(cheap({ db: { dbLinkCount: 2, aliasConflict: true }, app: { clusterId: "c1" } }));
    expect(codes(r)).toEqual(["alias_conflict", "cluster_app", "db_links_exist"]);
  });

  it("still sees DB-known port reservations (and acks a busy hostPort)", () => {
    const r = assemblePreflight(cheap({ app: { hostPort: 7000 }, db: { targetReservedPorts: [7000] } }));
    expect(r.requiredAcks).toEqual(["hostPortChanged"]);
  });
});

describe("assemblePreflight — warnings", () => {
  const w = (over: Parameters<typeof facts>[0]) => warnCodes(assemblePreflight(facts(over)));

  it.each([
    ["dns_manual_repoint", { app: { domain: "x.example.com", domainKind: "custom" } }],
    ["magic_domain_changes", { app: { domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" } }],
    ["env_may_reference_old_host", { app: { envKeysReferencingOldHost: ["PUBLIC_URL"] } }],
    ["local_backups_stranded", { app: { localBackupCount: 3 } }],
    ["image_may_differ", { app: { source: "IMAGE" } }],
    ["git_rebuild", { app: { source: "GIT", pushToRegistry: false } }],
    ["tunnel_resync", { app: { tunnelExposed: true } }],
    ["custom_cert_redelivered", { app: { hasCustomCert: true } }],
    ["stopped_app_started_briefly", { app: { status: "STOPPED" } }],
    ["tls_http01_gap", { app: { domain: "x.example.com", domainKind: "custom", certType: "le-http" } }],
    ["proxy_will_be_installed", { app: { domain: "x.example.com", domainKind: "custom" }, db: { targetHasDomainApps: false } }],
    ["history_splits", {}],
    ["downtime_estimate", {}],
    ["xattrs_acl_not_preserved", {}],
  ] as [string, Parameters<typeof facts>[0]][])("%s", (code, over) => {
    expect(w(over)).toContain(code);
  });

  it("git_rebuild is NOT raised when the app pushes to a registry", () => {
    expect(w({ app: { source: "GIT", pushToRegistry: true } })).not.toContain("git_rebuild");
  });

  it("self_urls_rewritten: a template compose that bakes the old magic domain / server ip", () => {
    const composeFile = "services:\n  a:\n    environment:\n      URL: http://blog-ab12cd.1-2-3-4.sslip.io\n";
    expect(w({ app: { source: "COMPOSE", isTemplate: true, volumes: [], composeFile, domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" } })).toContain("self_urls_rewritten");
    expect(w({ app: { source: "COMPOSE", isTemplate: false, volumes: [], composeFile, domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" } })).not.toContain("self_urls_rewritten");
  });

  it("downtime_estimate carries the range in seconds", () => {
    const r = assemblePreflight(facts());
    const d = r.warnings.find((x) => x.code === "downtime_estimate")!;
    expect(d.details).toEqual({ lowSec: r.plan.estimatedDowntimeSec.low, highSec: r.plan.estimatedDowntimeSec.high });
  });

  it("every warning code the assembly emits is a known code", () => {
    const all = new Set<string>();
    for (const over of [
      {}, { app: { domain: "x.example.com", domainKind: "custom", certType: "le-http", status: "STOPPED", tunnelExposed: true, hasCustomCert: true, localBackupCount: 1, envKeysReferencingOldHost: ["K"], source: "GIT" }, db: { targetHasDomainApps: false } },
    ] as Parameters<typeof facts>[0][]) for (const c of warnCodes(assemblePreflight(facts(over)))) all.add(c);
    for (const c of all) expect(APP_MOVE_WARNING_CODES).toContain(c);
  });
});

describe("pure helpers", () => {
  it("deriveTargetDomain: magic keeps its label with the target's ip; custom is untouched; tunnel-only target drops magic", () => {
    const t = { publicIp: "5.6.7.8", publicIpv6: null, wildcardDomain: null, magicSuffix: null, proxyBind: "all" };
    expect(deriveTargetDomain({ name: "blog", domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" }, t, "sslip.io")).toEqual({ kind: "magic", from: "blog-ab12cd.1-2-3-4.sslip.io", to: "blog-ab12cd.5-6-7-8.sslip.io", dropped: false });
    expect(deriveTargetDomain({ name: "blog", domain: "blog-ab12cd.x.apps.example.com", domainKind: "magic" }, { ...t, wildcardDomain: "apps.example.com" }, "sslip.io").to).toBe("blog-ab12cd.apps.example.com");
    expect(deriveTargetDomain({ name: "blog", domain: "blog.example.com", domainKind: "custom" }, t, "sslip.io")).toEqual({ kind: "custom", from: "blog.example.com", to: "blog.example.com", dropped: false });
    expect(deriveTargetDomain({ name: "blog", domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" }, { ...t, proxyBind: "none" }, "sslip.io")).toMatchObject({ to: null, dropped: true });
    expect(deriveTargetDomain({ name: "blog", domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" }, { ...t, publicIp: "10.0.0.5" }, "sslip.io")).toMatchObject({ to: null, dropped: true }); // private ip cannot serve a magic domain
  });

  it("pickFreePort: lowest free; null when exhausted", () => {
    expect(pickFreePort(new Set([20000, 20001]), 20000, 20005)).toBe(20002);
    expect(pickFreePort(new Set([1, 2]), 1, 2)).toBeNull();
  });

  it("partBytesFromEnv: default 256 MiB, clamped to 32..1024, junk falls back", () => {
    expect(partBytesFromEnv(undefined)).toBe(256 * MiB);
    expect(partBytesFromEnv("")).toBe(256 * MiB);
    expect(partBytesFromEnv("64")).toBe(64 * MiB);
    expect(partBytesFromEnv("1")).toBe(32 * MiB);
    expect(partBytesFromEnv("99999")).toBe(1024 * MiB);
    expect(partBytesFromEnv("abc")).toBe(256 * MiB);
  });

  it("estimateDowntimeSec: range is 0.6x..1.8x; a measured link shortens the transfer; deploy time uses the median of recent deploys", () => {
    const slow = estimateDowntimeSec({ volumeBytes: [GiB], linkMbps: null, recentDeployMs: [], source: "IMAGE", stop: true });
    const fast = estimateDowntimeSec({ volumeBytes: [GiB], linkMbps: 8000, recentDeployMs: [], source: "IMAGE", stop: true });
    expect(fast.high).toBeLessThan(slow.high);
    // nominal = 5 stop + (1GiB/60e6 + 1GiB/20e6 + 1GiB/80e6) + 10 + 60 deploy
    const nominal = 5 + (GiB / 60e6 + GiB / 20e6 + GiB / 80e6) + 10 + 60;
    expect(slow).toEqual({ low: Math.round(nominal * 0.6), high: Math.round(nominal * 1.8) });
    const withHist = estimateDowntimeSec({ volumeBytes: [], linkMbps: null, recentDeployMs: [100_000, 20_000, 60_000], source: "GIT", stop: false });
    expect(withHist).toEqual({ low: Math.round((10 + 60) * 0.6), high: Math.round((10 + 60) * 1.8) }); // median 60s, no stop
    expect(estimateDowntimeSec({ volumeBytes: [], linkMbps: null, recentDeployMs: [], source: "COMPOSE", stop: false }).high).toBe(Math.round((10 + 180) * 1.8));
  });
});
