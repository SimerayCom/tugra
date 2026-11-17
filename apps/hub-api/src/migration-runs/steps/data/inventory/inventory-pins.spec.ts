import { InventoryHostFake } from "./testing/inventory-host-fake";
import { inventoryShellLines } from "./inventory-script";
import { parseReportBody, type HostInventory } from "./host-protocol";
import { derivePins, normalizedRepo, pinsToWrite } from "./inventory-pins";
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
const ctr = (id: string, name: string, image: string, digests: string[], state = "running") => ({ id, name, image, state, ...(digests.length ? { repoDigests: digests } : {}) });

describe("derivePins (R11)", () => {
  const cand = (uuid: string, image: string, host = "host-1") => ({ itemRef: `app:${host}:${uuid}`, image });

  it("pins a floating-tag image app to the digest its own running container reports, scoped to its source host", () => {
    const pins = derivePins([cand(U1, "getmeili/meilisearch:latest")], new Map([["host-1", inv([ctr(H("a"), `${U1}-170000000000`, "getmeili/meilisearch:latest", [`getmeili/meilisearch@${D1}`])])]]));
    expect(pins).toEqual([{ kind: "image-pin", key: "getmeili/meilisearch:latest", scope: "host-1", value: D1, evidence: "host-loop-reported" }]);
  });

  it("the candidate's containerPrefix lets its <prefix>-<timestamp> container pin; another app's prefix does not", () => {
    const inventories = new Map([["host-1", inv([ctr(H("a"), "shop-20261110T153012", "getmeili/meilisearch:latest", [`getmeili/meilisearch@${D1}`])])]]);
    expect(derivePins([{ ...cand(U1, "getmeili/meilisearch:latest"), containerPrefix: "shop" }], inventories)).toEqual([{ kind: "image-pin", key: "getmeili/meilisearch:latest", scope: "host-1", value: D1, evidence: "host-loop-reported" }]);
    expect(derivePins([cand(U1, "getmeili/meilisearch:latest")], inventories)).toEqual([]);
    expect(derivePins([{ ...cand(U1, "getmeili/meilisearch:latest"), containerPrefix: "other" }], inventories)).toEqual([]);
  });

  it("a single-host run (label `_`) pins for every server; a tag that is not floating, a stopped container and a foreign container pin nothing", () => {
    const inventories = new Map([["_", inv([ctr(H("a"), U1, "nginx", [`nginx@${D1}`]), ctr(H("b"), U2, "nginx", [`nginx@${D2}`], "exited"), ctr(H("c"), "other", "nginx", [`nginx@${D2}`])])]]);
    expect(derivePins([cand(U1, "nginx", "_")], inventories)).toEqual([{ kind: "image-pin", key: "nginx", scope: "", value: D1, evidence: "host-loop-reported" }]);
    expect(derivePins([cand(U2, "nginx", "_")], inventories)).toEqual([]); // its container is stopped
    expect(derivePins([cand(U3, "nginx", "_")], inventories)).toEqual([]); // no container of its own
    expect(derivePins([cand(U1, "nginx:1.27", "_")], inventories)).toEqual([]); // not floating
  });

  it("only a digest of the image's own repository counts, with the Docker Hub aliases folded", () => {
    const inventories = new Map([["host-1", inv([ctr(H("a"), U1, "nginx:latest", [`registry.example.test/mirror/nginx@${D2}`, `nginx@${D1}`])])]]);
    expect(derivePins([cand(U1, "docker.io/library/nginx:latest")], inventories)[0]).toMatchObject({ value: D1 });
    expect(normalizedRepo("docker.io/library/nginx:latest")).toBe("nginx");
    expect(normalizedRepo("ghcr.io/Org/App")).toBe("ghcr.io/org/app");
  });

  it("two apps on one host running the same tag with different digests are ambiguous: nothing is pinned; the same digest is one pin", () => {
    const a = [ctr(H("a"), U1, "x/y:latest", [`x/y@${D1}`]), ctr(H("b"), U2, "x/y:latest", [`x/y@${D2}`])];
    expect(derivePins([cand(U1, "x/y:latest"), cand(U2, "x/y:latest")], new Map([["host-1", inv(a)]]))).toEqual([]);
    const b = [ctr(H("a"), U1, "x/y:latest", [`x/y@${D1}`]), ctr(H("b"), U2, "x/y:latest", [`x/y@${D1}`])];
    expect(derivePins([cand(U1, "x/y:latest"), cand(U2, "x/y:latest")], new Map([["host-1", inv(b)]]))).toHaveLength(1);
  });

  it("an incomplete inventory pins nothing (it cannot prove what the host runs)", () => {
    expect(derivePins([cand(U1, "x/y:latest")], new Map([["host-1", inv([ctr(H("a"), U1, "x/y:latest", [`x/y@${D1}`])], false)]]))).toEqual([]);
  });

  it("pinsToWrite never replaces an operator's own pin, but replaces an earlier host-reported one", () => {
    const derived = [{ kind: "image-pin" as const, key: "x/y:latest", scope: "host-1", value: D1, evidence: "host-loop-reported" as const }];
    expect(pinsToWrite(derived, [{ kind: "image-pin", key: "x/y:latest", scope: "host-1", value: D2, evidence: "operator-attested" }])).toEqual([]);
    expect(pinsToWrite(derived, [{ kind: "image-pin", key: "x/y:latest", scope: "host-1", value: D2, evidence: "host-loop-reported" }])).toEqual(derived);
    expect(pinsToWrite(derived, [{ kind: "image-pin", key: "x/y:latest", scope: "other", value: D2, evidence: "operator-attested" }])).toEqual(derived);
  });

  it("an operator's every-server pin (scope \"\") holds against a host-scoped derived pin: pinFor would otherwise prefer the derived one", () => {
    const derived = [{ kind: "image-pin" as const, key: "x/y:latest", scope: "host-1", value: D1, evidence: "host-loop-reported" as const }];
    const operatorAll = { kind: "image-pin" as const, key: "x/y:latest", scope: "", value: D2, evidence: "operator-attested" as const };
    expect(pinsToWrite(derived, [operatorAll])).toEqual([]);
    // another image's every-server pin, and a host-reported every-server pin, do not block it
    expect(pinsToWrite(derived, [{ ...operatorAll, key: "x/z:latest" }])).toEqual(derived);
    expect(pinsToWrite(derived, [{ ...operatorAll, evidence: "host-loop-reported" }])).toEqual(derived);
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

  it("a floating-tag app gets the digest the host really runs as a host-loop-reported pin; a pinned tag gets none", async () => {
    const { svc, hints, text } = ingestRun();
    await svc.ingest(OP, text);
    expect(await hints.list("run1")).toEqual([{ kind: "image-pin", key: "getmeili/meilisearch:latest", scope: "host-1", value: D1, evidence: "host-loop-reported" }]);
  });

  it("an app with a custom container name prefix: its <prefix>-<timestamp> container is found through the plan's containerPrefix (and not without it)", async () => {
    const withPrefix = ingestRun(undefined, { name: "shop", planned: true });
    await withPrefix.svc.ingest(OP, withPrefix.text);
    expect(await withPrefix.hints.list("run1")).toEqual([{ kind: "image-pin", key: "getmeili/meilisearch:latest", scope: "host-1", value: D1, evidence: "host-loop-reported" }]);
    const without = ingestRun(undefined, { name: "shop", planned: false });
    await without.svc.ingest(OP, without.text);
    expect(await without.hints.list("run1")).toEqual([]);
  });

  it("an operator's own pin survives the report; re-running the inventory refreshes a host-reported one", async () => {
    const own = ingestRun(D2);
    await own.svc.ingest(OP, own.text);
    expect((await own.hints.list("run1"))[0]).toMatchObject({ value: D2, evidence: "operator-attested" });
    const again = ingestRun();
    await again.svc.ingest(OP, again.text);
    await again.svc.ingest(OP, again.text);
    expect(await again.hints.list("run1")).toHaveLength(1);
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
