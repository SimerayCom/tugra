import { InventoryHostFake } from "./testing/inventory-host-fake";
import { inventoryShellLines } from "./inventory-script";
import { parseReportBody, type HostInventory } from "./host-protocol";
import { deriveExactImages, exactKeyOf, normalizedRepo } from "./inventory-pins";
import { HostReportService } from "./host-report.service";
import { FakeHostReports } from "./testing/fake-host-reports";
import { InMemoryRunHints } from "../../import/baseline/run-hints";
import type { MigrationTokenContext } from "../../../../importer/migration-token.service";

const U1 = "a1b2c3d4e5f6a7b8c9d0e1f2";
const U2 = "b1b2c3d4e5f6a7b8c9d0e1f2";
const U3 = "c1b2c3d4e5f6a7b8c9d0e1f2";
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const H = (n: string) => n.repeat(64).slice(0, 64);

const inv = (containers: HostInventory["containers"], complete = true): HostInventory => ({ ref: "host-1", host: { name: "h", docker: "27", os: "" }, containers, mounts: [], volumes: [], binds: [], complete, rejected: 0 });
const ctr = (id: string, name: string, image: string, digests: string[], state = "running", version?: string) => ({ id, name, image, state, ...(digests.length ? { repoDigests: digests } : {}), ...(version ? { imageVersion: version } : {}) });

const hint = (key: string, value: string) => ({ kind: "exact-image" as const, key, scope: "", value, evidence: "host-loop-reported" as const });

describe("deriveExactImages (R11): the exact image the source runs", () => {
  const cand = (uuid: string, image: string | undefined, host = "host-1", kind: "app" | "database" = "app") => ({ itemRef: `${kind}:${host}:${uuid}`, kind, ...(image ? { image } : {}) });
  const one = (containers: HostInventory["containers"], host = "host-1") => new Map([[host, inv(containers)]]);

  it("pins a floating-tag image app to repo:latest@digest of its own running container, keyed by its itemRef", () => {
    const out = deriveExactImages([cand(U1, "getmeili/meilisearch:latest")], one([{ ...ctr(H("a"), `${U1}-170000000000`, "getmeili/meilisearch:latest", [`getmeili/meilisearch@${D1}`], "running", "1.11.3") }]));
    expect(out).toEqual([hint(`app:host-1:${U1}`, `getmeili/meilisearch:latest@${D1} 1.11.3`)]);
  });

  it("pins an app on a MOVING tag too (redis:7.2 moves under a patch release)", () => {
    const out = deriveExactImages([cand(U1, "redis:7.2")], one([ctr(H("a"), `${U1}-170000000000`, "redis:7.2", [`redis@${D2}`])]));
    expect(out).toEqual([hint(`app:host-1:${U1}`, `redis:7.2@${D2}`)]);
  });

  it("the candidate's containerPrefix lets its <prefix>-<timestamp> container pin; another app's prefix does not", () => {
    const inventories = one([ctr(H("a"), "shop-20261110T153012", "getmeili/meilisearch:latest", [`getmeili/meilisearch@${D1}`])]);
    expect(deriveExactImages([{ ...cand(U1, "getmeili/meilisearch:latest"), containerPrefix: "shop" }], inventories)).toHaveLength(1);
    expect(deriveExactImages([cand(U1, "getmeili/meilisearch:latest")], inventories)).toEqual([]);
    expect(deriveExactImages([{ ...cand(U1, "getmeili/meilisearch:latest"), containerPrefix: "other" }], inventories)).toEqual([]);
  });

  it("a single-host run (label `_`) works; a stopped container and a foreign container pin nothing", () => {
    const inventories = one([ctr(H("a"), U1, "nginx", [`nginx@${D1}`]), ctr(H("b"), U2, "nginx", [`nginx@${D2}`], "exited"), ctr(H("c"), "other", "nginx", [`nginx@${D2}`])], "_");
    expect(deriveExactImages([cand(U1, "nginx", "_")], inventories)).toEqual([hint(`app:_:${U1}`, `nginx:latest@${D1}`)]);
    expect(deriveExactImages([cand(U2, "nginx", "_")], inventories)).toEqual([]); // its container is stopped
    expect(deriveExactImages([cand(U3, "nginx", "_")], inventories)).toEqual([]); // no container of its own
  });

  it("only a digest of the image's own repository counts, with the Docker Hub aliases folded", () => {
    const inventories = one([ctr(H("a"), U1, "nginx:latest", [`registry.example.test/mirror/nginx@${D2}`, `nginx@${D1}`])]);
    expect(deriveExactImages([cand(U1, "docker.io/library/nginx:latest")], inventories)[0].value).toBe(`docker.io/library/nginx:latest@${D1}`);
    expect(normalizedRepo("docker.io/library/nginx:latest")).toBe("nginx");
    expect(normalizedRepo("ghcr.io/Org/App")).toBe("ghcr.io/org/app");
  });

  it("a database: the plan's own image when it names one, else the one image its running container has (a stock postgres:16-alpine)", () => {
    const inventories = one([ctr(H("a"), U1, "postgres:16-alpine", [`postgres@${D1}`]), ctr(H("b"), U2, "pgvector/pgvector:pg16", [`pgvector/pgvector@${D2}`])]);
    expect(deriveExactImages([cand(U1, undefined, "host-1", "database")], inventories)).toEqual([hint(`database:host-1:${U1}`, `postgres:16-alpine@${D1}`)]);
    expect(deriveExactImages([cand(U2, "pgvector/pgvector:pg16", "host-1", "database")], inventories)).toEqual([hint(`database:host-1:${U2}`, `pgvector/pgvector:pg16@${D2}`)]);
  });

  it("a stack member: its container is <member>-<service uuid>; a member of the same stack with another name is not mistaken for it", () => {
    const svc = `service:host-1:${U1}`;
    const inventories = one([ctr(H("a"), `meilisearch-${U1}`, "getmeili/meilisearch:latest", [`getmeili/meilisearch@${D1}`], "running", "1.12.3"), ctr(H("b"), `redis-${U1}`, "redis:7.2", [`redis@${D2}`])]);
    const out = deriveExactImages(
      [
        { itemRef: svc, kind: "service", member: "meilisearch", image: "getmeili/meilisearch:latest" },
        { itemRef: svc, kind: "service", member: "redis", image: "redis:7.2" },
        { itemRef: svc, kind: "service", member: "worker", image: "x/worker:latest" },
      ],
      inventories,
    );
    expect(out).toEqual([hint(`${svc}#meilisearch`, `getmeili/meilisearch:latest@${D1} 1.12.3`), hint(`${svc}#redis`, `redis:7.2@${D2}`)]);
    expect(exactKeyOf({ itemRef: svc, member: "redis" })).toBe(`${svc}#redis`);
  });

  it("two apps on one host running the same tag with different digests are ambiguous: nothing is pinned; the same digest is fine", () => {
    const a = [ctr(H("a"), U1, "x/y:latest", [`x/y@${D1}`]), ctr(H("b"), U2, "x/y:latest", [`x/y@${D2}`])];
    expect(deriveExactImages([cand(U1, "x/y:latest"), cand(U2, "x/y:latest")], one(a)).map((h) => h.value)).toEqual([`x/y:latest@${D1}`, `x/y:latest@${D2}`]); // each container is its own app
    const two = [ctr(H("a"), `${U1}-1`, "x/y:latest", [`x/y@${D1}`]), ctr(H("b"), `${U1}-2`, "x/y:latest", [`x/y@${D2}`])];
    expect(deriveExactImages([cand(U1, "x/y:latest")], one(two))).toEqual([]); // two containers of ONE app with two digests: ambiguous
  });

  it("an incomplete inventory, an old script (no digests, no label) and a locally built image pin nothing", () => {
    expect(deriveExactImages([cand(U1, "x/y:latest")], new Map([["host-1", inv([ctr(H("a"), U1, "x/y:latest", [`x/y@${D1}`])], false)]]))).toEqual([]);
    expect(deriveExactImages([cand(U1, "x/y:latest")], one([ctr(H("a"), U1, "x/y:latest", [])]))).toEqual([]);
    expect(deriveExactImages([cand(U1, "x/y:1.2")], one([ctr(H("a"), U1, "x/y:1.2", [], "running", "1.2.9")]))).toEqual([]); // a label alone never rewrites a tag that is not floating
  });

  it("with no digest, a floating tag whose image labels its version is pinned to that version tag", () => {
    const out = deriveExactImages([cand(U1, "minio/minio:latest")], one([ctr(H("a"), U1, "minio/minio:latest", [], "running", "RELEASE.2024-05-10T01-41-38Z")]));
    expect(out).toEqual([hint(`app:host-1:${U1}`, "minio/minio:RELEASE.2024-05-10T01-41-38Z RELEASE.2024-05-10T01-41-38Z")]);
  });

  it("an item the owner opted out of, and an item the operator pinned by hand, are left alone", () => {
    const inventories = one([ctr(H("a"), U1, "x/y:latest", [`x/y@${D1}`]), ctr(H("b"), `meili-${U2}`, "m/m:latest", [`m/m@${D1}`])]);
    const cands = [cand(U1, "x/y:latest"), { itemRef: `service:host-1:${U2}`, kind: "service" as const, member: "meili", image: "m/m:latest" }];
    expect(deriveExactImages(cands, inventories, [{ kind: "exact-off", key: `app:host-1:${U1}`, scope: "", value: "off", evidence: "operator-attested" }])).toHaveLength(1);
    expect(deriveExactImages(cands, inventories, [{ kind: "image-pin", key: "x/y:latest", scope: "", value: D2, evidence: "operator-attested" }])).toHaveLength(1);
    expect(deriveExactImages(cands, inventories, [{ kind: "service-pin", key: `service:host-1:${U2}#meili`, scope: "", value: "m/m:1", evidence: "operator-attested" }])).toHaveLength(1);
    expect(deriveExactImages(cands, inventories, [{ kind: "service-pin", key: `service:host-1:${U2}#meili`, scope: "", value: "m/m:1", evidence: "source-api-reported" }])).toHaveLength(2);
  });

  it("an image already on a digest is not touched", () => {
    expect(deriveExactImages([cand(U1, `x/y:1@${D2}`)], one([ctr(H("a"), U1, `x/y:1@${D2}`, [`x/y@${D1}`])]))).toEqual([]);
  });
});

describe("the whole path: the real inventory script against a fake docker, then the ingest", () => {
  const TOKEN = `tugra_mig_${"A".repeat(43)}`;
  const OP = { opId: "op1", actorId: "user1", expiresAt: new Date() } as MigrationTokenContext;
  let fake: InventoryHostFake | null = null;
  afterEach(() => {
    fake?.dispose();
    fake = null;
  });

  function ingestRun(operatorPin?: string, prefix?: { name: string; planned: boolean }) {
    fake = new InventoryHostFake({
      containers: [
        { id: H("a"), name: prefix ? `${prefix.name}-20261110T153012` : `${U1}-170000000000`, image: "getmeili/meilisearch:latest", repoDigests: [`getmeili/meilisearch@${D1}`] },
        { id: H("b"), name: `${U2}-170000000001`, image: "gotenberg/gotenberg:8", repoDigests: [`gotenberg/gotenberg@${D2}`] },
      ],
    });
    const program = ["set -eu", 'die() { printf "tugra-migrator: %s\\n" "$1" >&2; exit "${2:-2}"; }', ...inventoryShellLines(), `TUGRA_MIGRATION_TOKEN=${TOKEN}`, "export TUGRA_MIGRATION_TOKEN", "tugra_inventory host-1 https://hub.example.test"].join("\n");
    const r = fake.sh(program, { TUGRA_NO_POST: "1", TUGRA_NO_REACH: "1" });
    expect(parseReportBody(r.stdout).inventory.get("host-1")!.containers[0].repoDigests).toEqual([`getmeili/meilisearch@${D1}`]);
    const hints = new InMemoryRunHints();
    if (operatorPin) hints.byRun.set("run1", [{ kind: "image-pin", key: "getmeili/meilisearch:latest", scope: "host-1", value: operatorPin, evidence: "operator-attested" }]);
    const prisma = {
      migrationRun: { findUnique: jest.fn(async () => ({ id: "run1", actorId: "user1", status: "RUNNING", targetServerId: "srv-t", serverMap: null, promotedFromId: null })) },
      server: { findUnique: jest.fn(async () => ({ teamId: "team1" })) },
      bulkTask: { findMany: jest.fn(async () => [{ itemRef: `app:host-1:${U1}` }, { itemRef: `app:host-1:${U2}` }]) },
      bulkOperation: {
        findUnique: jest.fn(async () => ({
          meta: {
            plan: {
              items: [
                { itemRef: `app:host-1:${U1}`, kind: "app", proposed: { source: "IMAGE", image: "getmeili/meilisearch:latest", ...(prefix?.planned ? { containerPrefix: prefix.name } : {}) } },
                { itemRef: `app:host-1:${U2}`, kind: "app", proposed: { source: "IMAGE", image: "gotenberg/gotenberg:8" } },
              ],
            },
          },
        })),
      },
    };
    const svc = new HostReportService(prisma as never, { requirePermission: jest.fn(async () => undefined) } as never, new FakeHostReports(), hints);
    return { svc, hints, text: r.stdout };
  }

  it("every image app gets the exact image the host really runs as a host-loop-reported hint, a moving tag included", async () => {
    const { svc, hints, text } = ingestRun();
    await svc.ingest(OP, text);
    expect(await hints.list("run1")).toEqual([
      { kind: "exact-image", key: `app:host-1:${U1}`, scope: "", value: `getmeili/meilisearch:latest@${D1}`, evidence: "host-loop-reported" },
      { kind: "exact-image", key: `app:host-1:${U2}`, scope: "", value: `gotenberg/gotenberg:8@${D2}`, evidence: "host-loop-reported" },
    ]);
  });

  it("an app with a custom container name prefix: its <prefix>-<timestamp> container is found through the plan's containerPrefix (and not without it)", async () => {
    const withPrefix = ingestRun(undefined, { name: "shop", planned: true });
    await withPrefix.svc.ingest(OP, withPrefix.text);
    expect((await withPrefix.hints.list("run1")).map((h) => h.key)).toEqual([`app:host-1:${U1}`, `app:host-1:${U2}`]);
    const without = ingestRun(undefined, { name: "shop", planned: false });
    await without.svc.ingest(OP, without.text);
    expect((await without.hints.list("run1")).map((h) => h.key)).toEqual([`app:host-1:${U2}`]);
  });

  it("an operator's own pin survives the report; re-running the inventory refreshes a host-reported one", async () => {
    const own = ingestRun(D2);
    await own.svc.ingest(OP, own.text);
    const list = await own.hints.list("run1");
    expect(list.find((h) => h.kind === "image-pin")).toMatchObject({ value: D2, evidence: "operator-attested" });
    expect(list.some((h) => h.kind === "exact-image" && h.key === `app:host-1:${U1}`)).toBe(false); // the operator's pin answers for that app
    const again = ingestRun();
    await again.svc.ingest(OP, again.text);
    await again.svc.ingest(OP, again.text);
    expect(await again.hints.list("run1")).toHaveLength(2);
  });

  it("an app the owner opted out of keeps no exact image, and the opt-out holds across a second report", async () => {
    const r = ingestRun();
    r.hints.byRun.set("run1", [{ kind: "exact-off", key: `app:host-1:${U1}`, scope: "", value: "off", evidence: "operator-attested" }]);
    await r.svc.ingest(OP, r.text);
    await r.svc.ingest(OP, r.text);
    expect((await r.hints.list("run1")).filter((h) => h.kind === "exact-image").map((h) => h.key)).toEqual([`app:host-1:${U2}`]);
  });

  it("without a hint store, or when the plan cannot be read, the report is still stored and nothing throws", async () => {
    const reports = new FakeHostReports();
    const prisma = {
      migrationRun: { findUnique: jest.fn(async () => ({ id: "run1", actorId: "user1", status: "RUNNING", targetServerId: "srv-t", serverMap: null })) },
      server: { findUnique: jest.fn(async () => ({ teamId: "team1" })) },
      bulkTask: { findMany: jest.fn(async () => [{ itemRef: `app:host-1:${U1}` }]) },
      bulkOperation: { findUnique: jest.fn(async () => { throw new Error("db down"); }) },
    };
    const text = ["ctr", H("a"), "n", "x/y:latest", "running"].join("\t");
    const body = [`TUGRA_AT\thost-1\tTUGRA_INV\t${text}`, "TUGRA_AT\thost-1\tTUGRA_INV\tend\t1"].join("\n");
    const noStore = new HostReportService(prisma as never, { requirePermission: jest.fn(async () => undefined) } as never, reports);
    await expect(noStore.ingest(OP, body)).resolves.toMatchObject({ stored: 1 });
    const failing = new HostReportService(prisma as never, { requirePermission: jest.fn(async () => undefined) } as never, new FakeHostReports(), new InMemoryRunHints());
    await expect(failing.ingest(OP, body)).resolves.toMatchObject({ stored: 1 });
  });
});

describe("the whole path for databases and stack members: real script, fake docker, ingest", () => {
  const TOKEN = `tugra_mig_${"A".repeat(43)}`;
  const OP = { opId: "op1", actorId: "user1", expiresAt: new Date() } as MigrationTokenContext;
  let fake: InventoryHostFake | null = null;
  afterEach(() => {
    fake?.dispose();
    fake = null;
  });

  it("a database on postgres:16-alpine and a stack's members get their exact image, with the image's own version label", async () => {
    fake = new InventoryHostFake({
      containers: [
        { id: H("a"), name: U1, image: "postgres:16-alpine", repoDigests: [`postgres@${D1}`], versionLabel: "16.4" },
        { id: H("b"), name: `meilisearch-${U2}`, image: "getmeili/meilisearch:latest", repoDigests: [`getmeili/meilisearch@${D2}`], versionLabel: "1.12.3" },
        { id: H("c"), name: `redis-${U2}`, image: "redis:7.2", repoDigests: [] },
      ],
    });
    const program = ["set -eu", 'die() { printf "tugra-migrator: %s\\n" "$1" >&2; exit "${2:-2}"; }', ...inventoryShellLines(), `TUGRA_MIGRATION_TOKEN=${TOKEN}`, "export TUGRA_MIGRATION_TOKEN", "tugra_inventory host-1 https://hub.example.test"].join("\n");
    const r = fake.sh(program, { TUGRA_NO_POST: "1", TUGRA_NO_REACH: "1" });
    const hints = new InMemoryRunHints();
    const prisma = {
      migrationRun: { findUnique: jest.fn(async () => ({ id: "run1", actorId: "user1", status: "RUNNING", targetServerId: "srv-t", serverMap: null, promotedFromId: null })) },
      server: { findUnique: jest.fn(async () => ({ teamId: "team1" })) },
      bulkTask: { findMany: jest.fn(async () => [{ itemRef: `database:host-1:${U1}` }, { itemRef: `service:host-1:${U2}` }]) },
      bulkOperation: {
        findUnique: jest.fn(async () => ({
          meta: {
            plan: { items: [{ itemRef: `database:host-1:${U1}`, kind: "database", proposed: { engine: "POSTGRES", version: "16", image: null } }] },
            stackImages: [{ itemRef: `service:host-1:${U2}`, images: [{ member: "meilisearch", image: "getmeili/meilisearch:latest" }, { member: "redis", image: "redis:7.2" }] }],
          },
        })),
      },
    };
    const svc = new HostReportService(prisma as never, { requirePermission: jest.fn(async () => undefined) } as never, new FakeHostReports(), hints);
    await svc.ingest(OP, r.stdout);
    expect(await hints.list("run1")).toEqual([
      { kind: "exact-image", key: `database:host-1:${U1}`, scope: "", value: `postgres:16-alpine@${D1} 16.4`, evidence: "host-loop-reported" },
      { kind: "exact-image", key: `service:host-1:${U2}#meilisearch`, scope: "", value: `getmeili/meilisearch:latest@${D2} 1.12.3`, evidence: "host-loop-reported" },
    ]); // redis reported no digest (a locally built image): it keeps what the source writes, and the run says "unknown"
  });
});

