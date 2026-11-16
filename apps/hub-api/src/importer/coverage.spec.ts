import { buildCoverage } from "./coverage";
import { REPLICAS_UNMAPPED_REASON } from "./apply-map";
import type { ForeignApp, ForeignFleet, ForeignService } from "./foreign-fleet";

const app = (over: Partial<ForeignApp> = {}): ForeignApp => ({ sourceRef: "a1", name: "web", kind: "git", buildPack: "nixpacks", serverRef: "s1", git: { url: "https://git/x" }, ...over });
const fleet = (apps: ForeignApp[]): ForeignFleet => ({ servers: [], apps, databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] });
const o = { sourceKind: "coolify" };

describe("buildCoverage", () => {
  it("is undefined for local-docker, for an empty fleet and for apps with nothing to report", () => {
    expect(buildCoverage(fleet([app({ notCarried: [{ field: "x", level: "info", reason: "r" }] })]), { sourceKind: "local-docker" })).toBeUndefined();
    expect(buildCoverage(fleet([]), o)).toBeUndefined();
    expect(buildCoverage(fleet([app()]), { sourceKind: "dokploy" })).toBeUndefined();
    expect(buildCoverage(fleet([app({ git: undefined })]), o)).toBeUndefined();
  });

  it("coolify: carries a repo-shape summary and a presence-only env section (names + reasons, never values)", () => {
    const c = buildCoverage(
      fleet([
        app({ git: { url: "git@github.com:o/r.git" }, envReport: { total: 3, previewSkipped: 1, unresolved: [{ key: "A", reason: "NO_VALUE" }], invalidKeys: ["B C"], tokenReadOnly: false } }),
        app({ sourceRef: "a2", name: "clean", envReport: { total: 2, previewSkipped: 0, unresolved: [], invalidKeys: [], tokenReadOnly: false } }),
      ]),
      o,
    )!;
    expect(c.git).toEqual({ apps: 2, https: 1, ssh: 1, githubApp: 0 });
    expect(c.env!.apps).toEqual([{ itemRef: "app:s1:a1", name: "web", unresolved: [{ key: "A", reason: "NO_VALUE" }], invalidKeys: ["B C"], previewSkipped: 1, tokenReadOnly: false }]); // the clean app is not listed
    expect(buildCoverage(fleet([app()]), { sourceKind: "dokploy" })?.git).toBeUndefined();
  });

  it("aggregates post-create unmapped, ingress unmapped, replicas and the source's notCarried per app (itemRef = plan item ref)", () => {
    const c = buildCoverage(
      fleet([
        app({
          triggerType: "tag",
          dockerContextPath: "./svc",
          replicas: 3,
          domains: [{ host: "a.com", primary: true, certType: "le-dns" }],
          notCarried: [{ field: "basicAuth", level: "warn", reason: "gated" }],
        }),
      ]),
      o,
    )!;
    expect(c.apps).toHaveLength(1);
    expect(c.apps[0]).toMatchObject({ itemRef: "app:s1:a1", name: "web" });
    const byField = Object.fromEntries(c.apps[0].notCarried.map((n) => [n.field, n]));
    expect(byField.triggerType.level).toBe("warn");
    expect(byField.dockerContextPath.level).toBe("info");
    expect(byField["domain:a.com dns-01"].level).toBe("info");
    expect(byField.replicas).toMatchObject({ field: "replicas", reason: REPLICAS_UNMAPPED_REASON, level: "info" });
    expect(byField.basicAuth.level).toBe("warn");
    // every row the hub itself derives carries a stable code the web translates (the source's own row here is a plain fixture)
    for (const [field, n] of Object.entries(byField)) if (field !== "basicAuth") expect(n.reasonCode).toEqual(expect.any(String));
    expect(byField.replicas).toMatchObject({ reasonCode: "replicas" });
    expect(byField["domain:a.com dns-01"]).toMatchObject({ reasonCode: "domain_dns01" });
    expect(byField.triggerType).toMatchObject({ reasonCode: "trigger_tag" });
  });

  it("adds the apply-time marker rows (labels always; Dockerfile only with a real repo; compose says labels live in the file)", () => {
    const c = buildCoverage(fleet([app({ buildPack: "dockerfile", sourceExtras: { labels: true, dockerfile: true } })]), o)!;
    expect(c.apps[0].notCarried.map((n) => n.field).sort()).toEqual(["customLabels", "inlineDockerfile"]);
    const noRepo = buildCoverage(fleet([app({ kind: "image", buildPack: "image", image: "x", git: undefined, sourceExtras: { dockerfile: true } })]), o);
    expect(noRepo).toBeUndefined();
    const compose = buildCoverage(fleet([app({ kind: "compose", buildPack: "dockercompose", composeFile: "services: {}", git: undefined, sourceExtras: { labels: true } })]), o)!;
    expect(compose.apps[0].notCarried).toMatchObject([{ field: "customLabels", level: "info", reason: "compose apps declare labels in the compose file" }]);
  });

  it("de-duplicates by field (first wins: the mapper's own row beats the source's)", () => {
    const c = buildCoverage(fleet([app({ staticSpa: false, notCarried: [{ field: "staticSpa", level: "warn", reason: "from source" }] })]), o)!;
    const rows = c.apps[0].notCarried.filter((n) => n.field === "staticSpa");
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).not.toBe("from source");
  });

  it("is deterministic: apps sorted by itemRef, entries warn-first then by field, independent of input order", () => {
    const a = app({ sourceRef: "b", name: "b", notCarried: [{ field: "z", level: "info", reason: "r" }, { field: "m", level: "warn", reason: "r" }, { field: "a", level: "info", reason: "r" }] });
    const b = app({ sourceRef: "a", name: "a", notCarried: [{ field: "q", level: "info", reason: "r" }] });
    const c1 = buildCoverage(fleet([a, b]), o)!;
    const c2 = buildCoverage(fleet([b, a]), o)!;
    expect(c1).toEqual(c2);
    expect(c1.apps.map((x) => x.itemRef)).toEqual(["app:s1:a", "app:s1:b"]);
    expect(c1.apps[1].notCarried.map((n) => n.field)).toEqual(["m", "a", "z"]);
  });

  it("carries no value material: only the marker, never label/Dockerfile text, even when the fleet app has stray text in sourceExtras-adjacent fields", () => {
    const c = buildCoverage(fleet([app({ buildPack: "dockerfile", sourceExtras: { labels: true, dockerfile: true } })]), o)!;
    expect(JSON.stringify(c)).not.toMatch(/FROM |=/);
  });
});

describe("buildCoverage: services (R39/R53/R33)", () => {
  const compose = (volumes: string, mounts: string, image = "example.test/search:1") =>
    `services:\n  search:\n    image: ${image}\n    volumes:\n${mounts}\nvolumes:\n${volumes}`;
  const svc = (composeFile: string, over: Partial<ForeignService> = {}): ForeignService => ({ sourceRef: "svc1", name: "search-a", serverRef: "s1", composeFile, memberApps: [], memberDbs: [], members: [{ name: "search", kind: "app", ref: "m1", domains: [] }], ...over });
  const fleetOf = (services: ForeignService[]): ForeignFleet => ({ servers: [], apps: [], databases: [], services, volumes: [], sharedEnv: [], warnings: [] });
  const entry = (c: ReturnType<typeof buildCoverage>, field: string) => c?.apps.flatMap((a) => a.notCarried).find((e) => e.field === field);

  it("a copy volume the streamed lane cannot carry (a mount path with a space) is flagged as a warning at plan time; a usable one is not", () => {
    const c = buildCoverage(fleetOf([svc(compose("  index:\n  good-data:\n", "      - \"index:/my data\"\n      - good-data:/more"))]), o);
    expect(entry(c, "volume:index")).toMatchObject({ level: "warn", reason: expect.stringContaining("streamed volume copy") });
    expect(entry(c, "volume:good-data")).toBeUndefined();
  });
  it("a MinIO service says its buckets are not copied with it", () => {
    const c = buildCoverage(fleetOf([svc(compose("  store:\n", "      - store:/data", "minio/minio:latest"), { name: "storage-a" })]), o);
    expect(entry(c, "objectData")).toMatchObject({ level: "warn", reason: expect.stringContaining("Object migration") });
  });
});
