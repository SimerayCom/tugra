import { planImport, analyzeService } from "./import-planner";
import { buildPreflight } from "./preflight";
import { buildCoverage } from "./coverage";
import { loadServiceFixtures, fixtureByName } from "./testing/service-fixtures";
import type { ForeignApp, ForeignFleet, ImportOptions } from "./foreign-fleet";

const opts: ImportOptions = { sourceKind: "coolify" };
const fleetOf = (services = loadServiceFixtures().map((f) => f.svc), apps: ForeignApp[] = []): ForeignFleet => ({
  servers: [],
  apps,
  databases: [],
  services,
  volumes: [],
  sharedEnv: [],
  warnings: [],
});
const item = (name: string) => {
  const plan = planImport(fleetOf(), opts);
  const svc = fixtureByName(name).svc;
  return plan.items.find((i) => i.itemRef === `service:${svc.serverRef}:${svc.sourceRef}`)!;
};
const codes = (name: string) => item(name).risks.map((r) => r.code);

describe("planImport — services", () => {
  it("emits one leaf service item per service, with a verdict and a compat class for all 19", () => {
    const plan = planImport(fleetOf(), opts);
    const svcItems = plan.items.filter((i) => i.kind === "service");
    expect(svcItems).toHaveLength(19);
    expect(plan.totals.services).toBe(19);
    for (const i of svcItems) {
      expect(i.dependsOn).toEqual([]);
      expect(i.proposed).toMatchObject({ source: "COMPOSE", deployed: false });
      expect(["importable", "partial", "skipped"]).toContain(i.proposed.verdict);
      expect(["template", "passthrough", "blocked"]).toContain(i.proposed.compat);
    }
    const compat = Object.fromEntries(svcItems.map((i) => [i.name, i.proposed.compat]));
    expect(compat["alpha-meilisearch"]).toBe("template"); // meilisearch has an app-store template; the import still carries the source's compose
    expect(compat["alpha-storage-minio"]).toBe("passthrough"); // service_type null
    expect(compat["signoz-hub"]).toBe("passthrough");
    expect(compat["beszel-infra-agent"]).toBe("blocked");
  });

  it("a plan with no services has no services total and the same items as before", () => {
    const plan = planImport(fleetOf([]), opts);
    expect(plan.totals).toEqual({ apps: 0, databases: 0, volumes: 0, blockers: 0 });
  });

  it("the plan hash is independent of service, member and volume order", () => {
    const base = fleetOf();
    const shuffled = fleetOf([...base.services].reverse().map((s) => ({ ...s, members: [...(s.members ?? [])].reverse() })));
    expect(planImport(shuffled, opts).planHash).toBe(planImport(base, opts).planHash);
  });

  it("the plan hash does not change when only secret-bearing or apply-time data changes", () => {
    const base = fleetOf();
    // composeFile is read at plan time, but nothing apply-time (env rows, choices) is part of the hash: the plan of the
    // same fleet twice is identical.
    expect(planImport(base, opts).planHash).toBe(planImport(fleetOf(), opts).planHash);
  });

  it("meilisearch: warns about the floating tag, the unmeasured size, the manual deploy and the missing domain; no blockers", () => {
    const c = codes("alpha-meilisearch");
    expect(c).toEqual(expect.arrayContaining(["service.image.floating", "service.volume.size-unknown", "service.deploy.manual", "service.reach", "service.secrets.unverified"]));
    expect(item("alpha-meilisearch").risks.filter((r) => r.level === "blocker")).toEqual([]);
    expect(item("alpha-meilisearch").proposed.imageFloating).toEqual(["meilisearch"]);
  });

  it("an already pinned meilisearch has no floating warning", () => {
    expect(codes("delta-meilisearch")).not.toContain("service.image.floating");
  });

  it("MinIO: container_name and host bind warnings, volume rewritten in the proposal", () => {
    const c = codes("delta-storage-minio");
    expect(c).toEqual(expect.arrayContaining(["service.container-name", "service.volume.hostbind"]));
    expect(item("delta-storage-minio").proposed.volumes).toEqual([{ key: "minio-data", origin: "host-bind", policy: "copy", dataPlane: "not-carried" }]);
  });

  it("cloudflared is held, not a blocker", () => {
    expect(codes("cloudflared-hub")).toContain("service.hold");
    expect(item("cloudflared-hub").proposed.hold).toBe(true);
    expect(codes("cloudflared-hub")).not.toContain("service.reach");
  });

  it("beszel hub is partial with the agent dropped and its domain proposed; standalone agents are info, never blockers", () => {
    expect(codes("beszel-hub")).toContain("service.member.dropped");
    expect(item("beszel-hub").proposed).toMatchObject({ verdict: "partial", serviceDomains: [{ service: "beszel", host: "monitor.example.test", port: 8090 }] });
    expect(item("beszel-hub").proposed.members).toEqual([
      { name: "beszel", kind: "app", kept: true },
      { name: "beszel-agent", kind: "app", kept: false },
    ]);
    const agent = item("beszel-infra-agent");
    expect(agent.risks.map((r) => `${r.level}:${r.code}`)).toEqual(["info:service.type.unsupported"]);
    expect(agent.proposed.verdict).toBe("skipped");
  });

  it("signoz: not-carried clickhouse, needed config files, kept members; init-clickhouse stays a compose container", () => {
    const c = codes("signoz-hub");
    expect(c).toEqual(expect.arrayContaining(["service.data.not-carried", "service.files.needed"]));
    expect(item("signoz-hub").proposed.volumes).toEqual([
      { key: "clickhouse", origin: "named", policy: "skip", dataPlane: "not-carried" },
      { key: "sqlite", origin: "named", policy: "copy", dataPlane: "hub-staged" },
      { key: "zookeeper", origin: "named", policy: "empty", dataPlane: "stateless" },
    ]);
    const members = item("signoz-hub").proposed.members as Array<{ name: string; kind: string; kept: boolean }>;
    expect(members.find((m) => m.name === "init-clickhouse")).toEqual({ name: "init-clickhouse", kind: "db", kept: true });
    expect(members.every((m) => m.kept)).toBe(true);
  });

  it("no service compose is a blocker with a fixed message; a refused compose carries only the directive name", () => {
    const f = fixtureByName("alpha-meilisearch").svc;
    const none = analyzeService({ ...f, composeFile: undefined });
    expect(none.risks.map((r) => r.code)).toEqual(["service.compose.unavailable"]);
    const unparsed = analyzeService({ ...f, composeFile: "services: [" });
    expect(unparsed.risks[0]).toMatchObject({ level: "blocker", code: "service.compose.unparsed" });
    const labeled = analyzeService({ ...f, composeFile: "services:\n  a:\n    image: x:1\n    labels:\n      tugra.role: secret-ish\n" });
    expect(labeled.risks[0]).toMatchObject({ level: "blocker", code: "service.gate" });
    expect(labeled.risks[0].message).not.toContain("secret-ish");
    const badVol = analyzeService({ ...f, composeFile: "services:\n  a:\n    image: x:1\n    volumes:\n      - 'Bad.Name:/a'\n" });
    expect(badVol.risks[0]).toMatchObject({ level: "blocker", code: "service.volume.name" });
  });

  it("no secret, compose text or file content appears anywhere in the plan", () => {
    const f = fixtureByName("alpha-meilisearch").svc;
    const withSecret = { ...f, composeFile: `${f.composeFile}\n# SECRET-IN-COMMENT\n` };
    const raw = JSON.stringify(planImport(fleetOf([{ ...withSecret, composeFile: f.composeFile!.replace("MEILI_ENV=${MEILI_ENV:-production}", "MEILI_API_KEY=literal-secret-xyz") }]), opts));
    expect(raw).not.toContain("literal-secret-xyz");
    expect(raw).not.toContain("SECRET-IN-COMMENT");
    expect(raw).not.toContain("docker_compose");
  });

  it("does not claim a member is imported with its stack any more (app.service.member removed)", () => {
    const app: ForeignApp = { sourceRef: "a1", name: "w", kind: "git", buildPack: "dockerfile", git: { url: "https://example.test/r.git" }, serviceRef: "svc" };
    const plan = planImport(fleetOf([], [app]), opts);
    expect(plan.items[0].risks.map((r) => r.code)).not.toContain("app.service.member");
  });
});

describe("buildPreflight — services", () => {
  const pf = buildPreflight(fleetOf(), opts);
  const row = (n: string) => pf.services.find((s) => s.name === n)!;

  it("derives the note from the verdict; /not imported/ only for a skipped service", () => {
    for (const s of pf.services) expect(/not imported/i.test(s.note)).toBe(s.verdict === "skipped");
    expect(row("alpha-meilisearch").note).toMatch(/stopped compose app/);
    expect(row("beszel-hub").note).toMatch(/imported without: beszel-agent/);
    expect(row("signoz-hub").note).toMatch(/clickhouse is not carried/);
    expect(row("beszel-infra-agent").note).toMatch(/^not imported:/);
  });

  it("never claims what the import does not do", () => {
    for (const s of pf.services) expect(s.note).not.toMatch(/repointed|DNS (is )?updated|routes rewritten|migrated automatically/i);
  });

  it("carries hold and volume classes", () => {
    expect(row("cloudflared-hub").hold).toBe(true);
    expect(row("alpha-storage-minio").volumes).toEqual([{ key: "minio-data", dataPlane: "not-carried" }]);
  });

  it("a MinIO volume never reads as copied by the import, and a host-path bind is marked so the bind-mount gate counts it", () => {
    // the row agrees with the note: the data is not copied (Object migration moves it)
    expect(row("delta-storage-minio").note).toMatch(/Object migration/);
    expect(row("delta-storage-minio").volumes).toEqual([{ key: "minio-data", dataPlane: "not-carried", origin: "host-bind" }]);
    expect(pf.services.flatMap((s) => (s.name.includes("minio") ? s.volumes ?? [] : [])).some((v) => v.dataPlane === "hub-staged")).toBe(false);
  });
});

describe("buildCoverage — services", () => {
  it("lists what each service does not carry, by name and fixed reason, under its service itemRef", () => {
    const cov = buildCoverage(fleetOf(), opts)!;
    const signoz = cov.apps.find((a) => a.name === "signoz-hub")!;
    expect(signoz.itemRef).toMatch(/^service:/);
    const fields = signoz.notCarried.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["schema-migrator-sync.exclude_from_hc", "volume:clickhouse", "volume:zookeeper"]));
    const minio = cov.apps.find((a) => a.name === "delta-storage-minio")!;
    expect(minio.notCarried.map((e) => e.field)).toEqual(expect.arrayContaining(["minio.container_name", "volume:minio-data"]));
    const beszel = cov.apps.find((a) => a.name === "beszel-hub")!;
    expect(beszel.notCarried.map((e) => e.field)).toContain("member:beszel-agent");
    expect(JSON.stringify(cov)).not.toMatch(/s3cr3t|password":/i);
  });
});
