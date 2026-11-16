import { dbEngineOfImage, loopVerdict, parseReportBody } from "./host-protocol";
import { mergeFreeze, freezeStateOf } from "./report-merge";
import { dataItemsOfHost, serverRefOfItem, sourceHostsOf } from "./host-hosts";

const T = "\t";
const A = "a".repeat(64);
const B = "b".repeat(64);
const at = (ref: string, ...f: string[]) => ["TUGRA_AT", ref, ...f].join(T);

describe("parseReportBody", () => {
  it("parses loop statuses and refuses a state, step or code outside the vocabulary", () => {
    const r = parseReportBody(
      [
        at("srv-a", "TUGRA_HOST", "DATA_SEED", "finished", "ok", "0"),
        at("srv-a", "TUGRA_HOST", "DATA_SEED", "launched", "started", "-"),
        at("srv-a", "TUGRA_HOST", "VERIFY", "finished", "ok", "0"), // not a loop step
        at("srv-a", "TUGRA_HOST", "DATA_SEED", "exploded", "ok", "0"), // unknown state
        at("srv-a", "TUGRA_HOST", "DATA_SEED", "failed", "Bad Code!", "-"), // charset
        at("srv-a", "TUGRA_HOST", "DATA_SEED", "failed", "ok", "9999"), // rc out of range
      ].join("\n"),
    );
    expect(r.loop).toEqual([
      { ref: "srv-a", step: "DATA_SEED", state: "finished", code: "ok", rc: 0 },
      { ref: "srv-a", step: "DATA_SEED", state: "launched", code: "started", rc: null },
    ]);
    expect(r.rejected).toBe(4);
  });

  it("a line without the TUGRA_AT label, or with a label outside the ref charset, is dropped and counted", () => {
    const r = parseReportBody(["TUGRA_HOST\tDATA_SEED\tfinished\tok\t0", at("a b", "TUGRA_HOST", "DATA_SEED", "finished", "ok", "0"), at("../x", "TUGRA_HOST", "DATA_SEED", "finished", "ok", "0"), "random noise from ssh"].join("\n"));
    expect(r.loop).toEqual([]);
    expect(r.rejected).toBe(4);
  });

  it("an inventory is complete only when its end line carries the number of lines before it", () => {
    const lines = [at("h", "TUGRA_INV", "ctr", A, "db", "postgres:16", "running"), at("h", "TUGRA_INV", "vol", "pg", "/var/lib/docker/volumes/pg/_data", "42", "1")];
    const whole = parseReportBody([...lines, at("h", "TUGRA_INV", "end", "2")].join("\n"));
    expect(whole.inventory.get("h")).toMatchObject({ complete: true, rejected: 0, volumes: [{ name: "pg", sizeKiB: 42, links: 1 }] });
    expect(parseReportBody([...lines, at("h", "TUGRA_INV", "end", "3")].join("\n")).inventory.get("h")!.complete).toBe(false); // a line went missing
    expect(parseReportBody(lines.join("\n")).inventory.get("h")!.complete).toBe(false); // no end marker: truncated upload
  });

  it("C19: `unknown` is a size, 0 is a different one, and anything else is rejected", () => {
    const r = parseReportBody(
      [
        at("h", "TUGRA_INV", "vol", "a", "/p/a", "unknown", "0"),
        at("h", "TUGRA_INV", "vol", "b", "/p/b", "0", "0"),
        at("h", "TUGRA_INV", "vol", "c", "/p/c", "-1", "0"),
        at("h", "TUGRA_INV", "bind", "/mnt/x", "unknown"),
        at("h", "TUGRA_INV", "bind", "/mnt/y", "NaN"),
      ].join("\n"),
    );
    const inv = r.inventory.get("h")!;
    expect(inv.volumes.map((v) => [v.name, v.sizeKiB])).toEqual([
      ["a", null],
      ["b", 0],
    ]);
    expect(inv.binds).toEqual([{ source: "/mnt/x", sizeKiB: null }]);
    expect(inv.rejected).toBe(2);
  });

  it("validates container ids, names, images, mount types and paths", () => {
    const bad = [
      at("h", "TUGRA_INV", "ctr", "short", "db", "postgres", "running"),
      at("h", "TUGRA_INV", "ctr", A, "db; reboot", "postgres", "running"),
      at("h", "TUGRA_INV", "ctr", A, "db", "img && id", "running"),
      at("h", "TUGRA_INV", "mount", A, "tmpfs", "-", "/x", "/y", "true"),
      at("h", "TUGRA_INV", "mount", A, "bind", "-", "relative", "/y", "true"),
      at("h", "TUGRA_INV", "mount", A, "bind", "-", "/x y", "/y", "true"),
      at("h", "TUGRA_INV", "nonsense", "x"),
    ];
    const r = parseReportBody(bad.join("\n"));
    const inv = r.inventory.get("h")!;
    expect(inv.containers).toEqual([]);
    expect(inv.mounts).toEqual([]);
    expect(inv.rejected).toBe(bad.length);
  });

  it("reach reports: numbers or `-`, three-digit http codes only", () => {
    const r = parseReportBody([at("h", "TUGRA_REACH", "200", "128", "64", "128", "9"), at("h", "TUGRA_REACH", "000", "-", "-", "-", "-"), at("h", "TUGRA_REACH", "20", "1", "1", "1", "1"), at("h", "TUGRA_REACH", "200", "x", "1", "1", "1")].join("\n"));
    expect(r.reach).toEqual([
      { ref: "h", pingCode: 200, hubPartMiB: 128, maxPassedMiB: 64, failedAtMiB: 128, seconds: 9 },
      { ref: "h", pingCode: 0, hubPartMiB: null, maxPassedMiB: null, failedAtMiB: null, seconds: null },
    ]);
    expect(r.rejected).toBe(2);
  });

  it("freeze lines: containers (only the running ones are recorded), outcomes, unresolved items and the end state", () => {
    const r = parseReportBody(
      [
        at("h", "TUGRA_FZ", "action", "freeze"),
        at("h", "TUGRA_CTR", "app:h:uuaaaaaaaaaaaaaaaaaaaaaa", A, "uuaaaaaaaaaaaaaaaaaaaaaa-170000000000", "ghcr.io/x/web:1", "0.0.0.0:80->80/tcp", "running"),
        at("h", "TUGRA_CTR", "database:h:uubbbbbbbbbbbbbbbbbbbbbb", B, "uubbbbbbbbbbbbbbbbbbbbbb", "postgres:16", "", "exited"),
        at("h", "TUGRA_STOP", A, "stopped"),
        at("h", "TUGRA_STOP", B, "kaboom"), // not an outcome
        at("h", "TUGRA_FZ", "unresolved", "app:h:ucccccccccccccccccccccccc"),
        at("h", "TUGRA_FZ", "done"),
      ].join("\n"),
    );
    const f = r.freeze.get("h")!;
    expect(f).toMatchObject({ action: "freeze", outcome: "done", stopped: { [A]: "stopped" }, unresolved: ["app:h:ucccccccccccccccccccccccc"] });
    expect(f.recorded.map((c) => c.id)).toEqual([A]); // the exited container is not recorded
    expect(r.rejected).toBe(1);
  });

  it("is bounded: more than the line cap is ignored, never a crash", () => {
    const many = Array.from({ length: 30_000 }, (_, i) => at("h", "TUGRA_HOST", "DATA_SEED", "running", "migrating", String(i % 200))).join("\n");
    expect(parseReportBody(many).lines).toBe(20_000);
  });
});

describe("loopVerdict", () => {
  it("ok / pending / bad", () => {
    expect(loopVerdict(null)).toBe("pending");
    expect(loopVerdict({ state: "finished", rc: 0 })).toBe("ok");
    expect(loopVerdict({ state: "finished", rc: 1 })).toBe("ok"); // partial: the data steps' own gates judge what is missing
    expect(loopVerdict({ state: "finished", rc: 6 })).toBe("bad");
    expect(loopVerdict({ state: "running", rc: null })).toBe("pending");
    expect(loopVerdict({ state: "launched", rc: null })).toBe("pending");
    for (const state of ["unreachable", "no-key", "no-host", "failed", "died"] as const) expect(loopVerdict({ state, rc: null })).toBe("bad");
  });
});

describe("dbEngineOfImage", () => {
  it.each([
    ["postgres:18-alpine", "POSTGRES"],
    ["docker.io/library/postgres@sha256:abc", "POSTGRES"],
    ["registry.example.test:5000/team/postgres:16", "POSTGRES"],
    ["postgis/postgis:16-3.4", "POSTGRES"],
    ["timescale/timescaledb:latest-pg16", "POSTGRES"],
    ["timescaledb", "POSTGRES"],
    ["mariadb:11", "MARIADB"],
    ["mysql:8", "MYSQL"],
    ["mongo:7", "MONGODB"],
    ["redis:7-alpine", "REDIS"],
    ["eqalpha/keydb:latest", "REDIS"],
    ["valkey/valkey:8", "REDIS"],
    ["clickhouse/clickhouse-server:24", "CLICKHOUSE"],
    ["ghcr.io/example/app:1", null],
    ["minio/minio:RELEASE.2025-04-22T22-12-26Z", null],
    ["getmeili/meilisearch:v1", null],
    ["postgres-exporter:1", null],
  ])("%s -> %s", (image, engine) => {
    expect(dbEngineOfImage(image)).toBe(engine);
  });
});

describe("mergeFreeze", () => {
  const part = (over: Partial<Parameters<typeof mergeFreeze>[1]> = {}) => ({ ref: "h", recorded: [{ id: A, name: "n", image: "i", ports: "", itemRef: "app:h:u" }], stopped: {}, started: {}, unresolved: [], outcome: null, errorCode: null, action: "freeze" as const, ...over });

  it("a finished freeze with every recorded container stopped is `stopped`; a failed or mismatched one is `stop-failed`", () => {
    expect(mergeFreeze(null, part({ stopped: { [A]: "stopped" }, outcome: "done" })).state).toBe("stopped");
    expect(mergeFreeze(null, part({ stopped: { [A]: "gone" }, outcome: "done" })).state).toBe("stopped");
    expect(mergeFreeze(null, part({ stopped: { [A]: "mismatch" }, outcome: "done" })).state).toBe("stop-failed");
    expect(mergeFreeze(null, part({ stopped: {}, outcome: "done" })).state).toBe("stop-failed"); // recorded but no outcome for it
    expect(mergeFreeze(null, part({ recorded: [], outcome: "done" })).state).toBe("stopped"); // nothing was running
    expect(mergeFreeze(null, part({ outcome: "error", errorCode: "unresolved-items" })).state).toBe("error");
    expect(mergeFreeze(null, part()).state).toBe("partial");
  });

  it("an unfreeze after a freeze keeps the record and ends `restarted`", () => {
    const first = mergeFreeze(null, part({ stopped: { [A]: "stopped" }, outcome: "done" }));
    const second = mergeFreeze(first.payload as unknown as Record<string, unknown>, part({ recorded: [], action: "unfreeze", started: { [A]: "started" }, outcome: "done" }));
    expect(second.state).toBe("restarted");
    expect(second.payload.recorded).toHaveLength(1);
    expect(freezeStateOf({ ...second.payload, started: { [A]: "failed" } })).toBe("restart-failed");
  });

  it("a re-run of an existing record keeps the unresolved list the operator already accepted", () => {
    const first = mergeFreeze(null, part({ unresolved: ["app:h:ux"], stopped: { [A]: "stopped" }, outcome: "done" }));
    const rerun = mergeFreeze(first.payload as unknown as Record<string, unknown>, part({ unresolved: [], stopped: { [A]: "stopped" }, outcome: "done" }));
    expect(rerun.payload.unresolved).toEqual(["app:h:ux"]);
  });
});

describe("host sets", () => {
  const items = {
    databases: [{ itemRef: "database:srv-a:u1" }, { itemRef: "database:srv-b:u2" }, { itemRef: "database:_:u3" }],
    volumes: [{ itemRef: "volume:srv-a:u1:data", excluded: false }, { itemRef: "volume:srv-a:u4:cache", excluded: true }],
    apps: [{ itemRef: "app:srv-c:u5" }],
    services: [],
  } as unknown as Parameters<typeof sourceHostsOf>[1];

  it("a run's hosts are its serverMap keys plus the refs its plan items carry; the unknown `_` is not a host", () => {
    expect(sourceHostsOf({ targetServerId: "t", serverMap: { "srv-z": "t2" } }, items)).toEqual(["srv-a", "srv-b", "srv-c", "srv-z"]);
    expect(sourceHostsOf({ targetServerId: "t", serverMap: null }, items)).toEqual(["srv-a", "srv-b", "srv-c"]);
    expect(serverRefOfItem("app:_:x")).toBe("_");
  });

  it("the data items of a host exclude excluded volumes and other hosts' items", () => {
    expect(dataItemsOfHost("srv-a", items)).toEqual(["database:srv-a:u1", "volume:srv-a:u1:data"]);
    expect(dataItemsOfHost("srv-c", items)).toEqual([]);
  });
});
