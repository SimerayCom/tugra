import { INVENTORY_ATTEST, INVENTORY_CODES, attestableFindings, crossCheckChecks, findingsOf, recommendPartMib, type CrossCheckInput } from "./cross-check";
import type { HostInventory, ReachReport } from "./host-protocol";

const id = (c: string) => c.repeat(64);
const UDB = "dbaaaaaaaaaaaaaaaaaaaaaa"; // a listed database (Coolify names a DB container by its uuid)
const UAPP = "appbbbbbbbbbbbbbbbbbbbbb";
const USVC = "svcccccccccccccccccccccc";
const GHOST = "dbghostgggggggggggggggggg"; // a database container the API does not list

const inv = (over: Partial<HostInventory> = {}): HostInventory => ({
  ref: "host-1",
  host: { name: "h", docker: "27", os: "" },
  containers: [
    { id: id("a"), name: UDB, image: "postgres:16-alpine", state: "running" },
    { id: id("b"), name: `${UAPP}-170000000000`, image: "ghcr.io/x/api:1", state: "running" },
    { id: id("c"), name: `postgres-${USVC}`, image: "postgres:16", state: "running" }, // a service component
    { id: id("d"), name: "coolify-db", image: "postgres:15-alpine", state: "running" }, // control plane, never data to migrate
    { id: id("e"), name: "tugra-agent", image: "ghcr.io/tugra/agent:1", state: "running" },
  ],
  mounts: [],
  volumes: [{ name: "pg-data", mountpoint: "/v/pg-data/_data", sizeKiB: 10, links: 1 }],
  binds: [],
  complete: true,
  rejected: 0,
  ...over,
});

const reach = (over: Partial<ReachReport> = {}): ReachReport => ({ ref: "host-1", pingCode: 200, hubPartMiB: 128, maxPassedMiB: 128, failedAtMiB: null, seconds: 3, ...over });

const planRefs = [`database:host-1:${UDB}`, `app:host-1:${UAPP}`, `service:host-1:${USVC}`];

const base = (over: Partial<CrossCheckInput> = {}): CrossCheckInput => ({
  hosts: ["host-1"],
  required: true,
  inventories: new Map([["host-1", inv()]]),
  reach: new Map([["host-1", reach()]]),
  planRefs,
  unlistedDbPolicy: "block",
  orphanVolumePolicy: "block",
  attestations: [],
  currentPartMiB: 128,
  ...over,
});

const codes = (c: ReturnType<typeof crossCheckChecks>) => c.map((x) => `${x.status}:${x.code}`);

describe("cross-check: nothing unlisted", () => {
  it("every database container is a plan item (or a service component, or infrastructure): only the passing reach check remains", () => {
    expect(findingsOf(inv(), planRefs)).toEqual([]);
    expect(codes(crossCheckChecks(base()))).toEqual([`pass:${INVENTORY_CODES.reachOk}`]);
  });
});

describe("R2/C6: a database container the API does not list", () => {
  const ghost = inv({ containers: [...inv().containers, { id: id("f"), name: GHOST, image: "mariadb:11", state: "running" }] });

  it("blocks (fail) by default and names the container, its image and the engine", () => {
    const f = findingsOf(ghost, planRefs);
    expect(f).toEqual([expect.objectContaining({ kind: "unlisted-db", key: `host-1/${GHOST}`, engine: "MARIADB", image: "mariadb:11" })]);
    const c = crossCheckChecks(base({ inventories: new Map([["host-1", ghost]]) })).find((x) => x.code === INVENTORY_CODES.unlistedDb)!;
    expect(c).toMatchObject({ status: "fail", subject: `host-1/${GHOST}`, ownerInput: "unlistedDbPolicy", evidence: "host-loop-reported", params: { host: "host-1", container: GHOST, engine: "MARIADB" } });
  });

  it("unlistedDbPolicy skip / carry turn it into a visible warning (the owner decided), never silence", () => {
    const run = (unlistedDbPolicy: "skip" | "carry") => codes(crossCheckChecks(base({ inventories: new Map([["host-1", ghost]]), unlistedDbPolicy })));
    expect(run("skip")).toContain(`warn:${INVENTORY_CODES.unlistedDbSkipped}`);
    expect(run("carry")).toContain(`warn:${INVENTORY_CODES.unlistedDbCarry}`);
  });

  it("an operator attestation on that exact finding excludes it; a mapping needs a note that names a real plan item", () => {
    const key = `host-1/${GHOST}`;
    const withAtt = (a: CrossCheckInput["attestations"]) => crossCheckChecks(base({ inventories: new Map([["host-1", ghost]]), attestations: a })).find((x) => x.subject === key)!;
    expect(withAtt([{ checkId: INVENTORY_ATTEST.excluded, subject: key }])).toMatchObject({ status: "warn", code: INVENTORY_CODES.unlistedDbExcluded });
    expect(withAtt([{ checkId: INVENTORY_ATTEST.excluded, subject: "host-1/another" }])).toMatchObject({ status: "fail" }); // someone else's finding
    expect(withAtt([{ checkId: INVENTORY_ATTEST.mapped, subject: key, note: `database:host-1:${UDB}` }])).toMatchObject({ status: "warn", code: INVENTORY_CODES.unlistedDbMapped, params: { item: `database:host-1:${UDB}` } });
    expect(withAtt([{ checkId: INVENTORY_ATTEST.mapped, subject: key, note: "database:host-1:notinthisplan" }])).toMatchObject({ status: "fail" });
    expect(withAtt([{ checkId: INVENTORY_ATTEST.mapped, subject: key }])).toMatchObject({ status: "fail" });
  });

  it("the failing finding makes the wait offer the attestations", () => {
    const checks = crossCheckChecks(base({ inventories: new Map([["host-1", ghost]]) }));
    expect(attestableFindings(checks)).toEqual([INVENTORY_ATTEST.excluded, INVENTORY_ATTEST.mapped]);
    expect(attestableFindings(crossCheckChecks(base()))).toEqual([]);
  });

  it("an item on another host does not account for a container (a uuid is matched per host)", () => {
    expect(findingsOf(inv(), [`database:other-host:${UDB}`, ...planRefs.slice(1)])).toHaveLength(1);
    // an item whose server ref is unknown (`_`) accounts for it anywhere
    expect(findingsOf(inv(), [`database:_:${UDB}`, ...planRefs.slice(1)])).toEqual([]);
  });

  it("a stopped (exited) database container is still a finding: its data directory exists", () => {
    const stopped = inv({ containers: [{ id: id("f"), name: GHOST, image: "postgres:15", state: "exited" }] });
    expect(findingsOf(stopped, planRefs)).toEqual([expect.objectContaining({ state: "exited" })]);
  });
});

describe("R14/N4: orphan volumes", () => {
  const orphan = inv({ volumes: [...inv().volumes, { name: "forgotten", mountpoint: "/v/forgotten/_data", sizeKiB: 5, links: 0 }, { name: "f".repeat(64), mountpoint: "/v/anon/_data", sizeKiB: 1, links: 0 }] });

  it("a named volume no container mounts blocks until skipped or excluded; an anonymous (64-hex) one is not a finding", () => {
    expect(findingsOf(orphan, planRefs).map((f) => f.name)).toEqual(["forgotten"]);
    const run = (over: Partial<CrossCheckInput>) => crossCheckChecks(base({ inventories: new Map([["host-1", orphan]]), ...over })).find((c) => c.code.startsWith("inventory.orphan-volume"))!;
    expect(run({})).toMatchObject({ status: "fail", code: INVENTORY_CODES.orphanVolume, ownerInput: "orphanVolumePolicy" });
    expect(run({ orphanVolumePolicy: "skip" })).toMatchObject({ status: "warn", code: INVENTORY_CODES.orphanVolumeSkipped });
    expect(run({ attestations: [{ checkId: INVENTORY_ATTEST.excluded, subject: "host-1/volume:forgotten" }] })).toMatchObject({ status: "warn", code: INVENTORY_CODES.orphanVolumeExcluded });
  });

  it("only `excluded` is offered for an orphan volume (there is nothing to map it to)", () => {
    expect(attestableFindings(crossCheckChecks(base({ inventories: new Map([["host-1", orphan]]) })))).toEqual([INVENTORY_ATTEST.excluded]);
  });
});

describe("C19: unknown sizes", () => {
  it("are said once per host with a count, as unknown (never zero), and only for paths that are in use", () => {
    const i = inv({ binds: [{ source: "/mnt/a", sizeKiB: null }, { source: "/mnt/b", sizeKiB: 0 }], volumes: [{ name: "pg-data", mountpoint: "/v/pg", sizeKiB: null, links: 1 }, { name: "x", mountpoint: "/v/x", sizeKiB: null, links: 0 }] });
    const c = crossCheckChecks(base({ inventories: new Map([["host-1", i]]), orphanVolumePolicy: "skip" })).find((x) => x.code === INVENTORY_CODES.sizeUnknown)!;
    expect(c).toMatchObject({ status: "warn", params: { host: "host-1", count: 2, first: "/mnt/a, pg-data" } });
  });
});

describe("completeness and requirement", () => {
  it("a truncated inventory fails and judges nothing else (it cannot prove an absence)", () => {
    const partial = inv({ complete: false, containers: [] });
    expect(codes(crossCheckChecks(base({ inventories: new Map([["host-1", partial]]) })))).toEqual([`fail:${INVENTORY_CODES.truncated}`]);
  });

  it("a host without an inventory is `unknown` (which fails) only for the host-loop runner", () => {
    expect(codes(crossCheckChecks(base({ inventories: new Map() })))).toEqual([`unknown:${INVENTORY_CODES.notTaken}`]);
    expect(crossCheckChecks(base({ inventories: new Map(), required: false }))).toEqual([]);
  });

  it("rejected lines are reported as a warning", () => {
    expect(codes(crossCheckChecks(base({ inventories: new Map([["host-1", inv({ rejected: 3 })]]) })))).toContain(`warn:${INVENTORY_CODES.rejectedLines}`);
  });
});

describe("R8: reach and the part size", () => {
  const run = (r: ReachReport | null, currentPartMiB: number | null = 128, required = true) => crossCheckChecks(base({ reach: new Map(r ? [["host-1", r]] : []), currentPartMiB, required }))[0];

  it("recommends the largest valid part size the path accepted", () => {
    expect(recommendPartMib(100)).toBe(64);
    expect(recommendPartMib(128)).toBe(128);
    expect(recommendPartMib(63)).toBe(32);
    expect(recommendPartMib(31)).toBe(0);
    expect(recommendPartMib(9999)).toBe(512);
  });

  it("fails with the recommendation when a proxy body cap is below the part size", () => {
    expect(run(reach({ maxPassedMiB: 64, failedAtMiB: 128 }))).toMatchObject({ status: "fail", code: INVENTORY_CODES.partSizeExceedsCap, params: { host: "host-1", partMiB: 128, acceptedMiB: 64, recommendMiB: 64 } });
    expect(run(reach({ maxPassedMiB: 0, failedAtMiB: 32 }))).toMatchObject({ status: "fail", params: { recommendMiB: 0 } });
  });

  it("judges the hub's CURRENT part size: lowering it after the probe makes an earlier probe pass", () => {
    expect(run(reach({ maxPassedMiB: 64, failedAtMiB: 128 }), 64)).toMatchObject({ status: "pass" });
    expect(run(reach({ maxPassedMiB: 128 }), 256)).toMatchObject({ status: "fail" });
  });

  it("an unreachable hub fails; a missing probe is unknown (host-loop) or silent (other runners)", () => {
    expect(run(reach({ pingCode: 0, hubPartMiB: null, maxPassedMiB: null }))).toMatchObject({ status: "fail", code: INVENTORY_CODES.reachFailed, params: { httpCode: 0 } });
    expect(run(reach({ pingCode: 502, hubPartMiB: null, maxPassedMiB: null }))).toMatchObject({ status: "fail", params: { httpCode: 502 } });
    expect(run(null)).toMatchObject({ status: "unknown", code: INVENTORY_CODES.reachUnknown });
    expect(crossCheckChecks(base({ reach: new Map(), required: false }))).toEqual([]);
    expect(run(reach({ maxPassedMiB: null }))).toMatchObject({ status: "unknown" }); // answered the ping but no probe ran
  });
});

describe("every check id fits the 80-char limit and is unique per finding", () => {
  it("long container names are hashed, not embedded", () => {
    const long = "x".repeat(120);
    const i = inv({ containers: [{ id: id("f"), name: long.slice(0, 100), image: "redis:7", state: "running" }, { id: id("g"), name: `${"y".repeat(99)}`, image: "redis:7", state: "running" }] });
    const ids = crossCheckChecks(base({ inventories: new Map([["host-1", i]]) })).map((c) => c.id);
    for (const x of ids) expect(x.length).toBeLessThanOrEqual(80);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
