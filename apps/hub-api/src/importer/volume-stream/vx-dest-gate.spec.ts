import { DUMP_DEST_PG_LAYOUT_TEXT, PHYSICAL_DEST_PG18_TEXT, dbGates, dumpDestLayout } from "./vx-dest-gate";

type Row = { engine: string; version: string; image: string; status: string; pgParentMount: boolean };
const db = (over: Partial<Row> = {}): Row => ({ engine: "POSTGRES", version: "16", image: "postgres:16", status: "NEW", pgParentMount: false, ...over });
const prismaOf = (row: Row | null, counts = { restore: 0, backup: 0 }) =>
  ({
    database: { findUnique: jest.fn().mockResolvedValue(row) },
    restore: { count: jest.fn().mockResolvedValue(counts.restore) },
    backup: { count: jest.fn().mockResolvedValue(counts.backup) },
  }) as never;

describe("dumpDestLayout (the streamed dump into a PostgreSQL destination)", () => {
  it("a PostgreSQL 18+ database with the persistent layout takes the dump (the refusal is lifted)", async () => {
    for (const status of ["NEW", "RUNNING", "FAILED", "PROVISIONING"]) {
      expect(await dumpDestLayout(prismaOf(db({ version: "18", image: "postgres:18-alpine", pgParentMount: true, status })), "d1")).toEqual({ ok: true });
    }
  });

  it("a never-started PostgreSQL 18+ row is accepted: provisioning gives it the persistent layout", async () => {
    expect(await dumpDestLayout(prismaOf(db({ version: "18", image: "postgres:18", status: "NEW" })), "d1")).toEqual({ ok: true });
    expect(await dumpDestLayout(prismaOf(db({ version: "latest", image: "postgres:19-alpine", status: "NEW" })), "d1")).toEqual({ ok: true });
  });

  it("a FAILED PostgreSQL 18+ row is accepted: its next provision decides its layout from whether a container exists", async () => {
    expect(await dumpDestLayout(prismaOf(db({ version: "18", image: "postgres:18", status: "FAILED" })), "d1")).toEqual({ ok: true });
  });

  it("the major comes from the image: a version-16 row on a postgres:18, postgres:latest or postgis image is refused once started", async () => {
    for (const image of ["postgres:18", "postgres:latest", "postgres:alpine", "postgis/postgis:18-3.6"]) {
      expect(await dumpDestLayout(prismaOf(db({ version: "16", image, status: "RUNNING" })), "d1")).toEqual({ ok: false, reason: DUMP_DEST_PG_LAYOUT_TEXT });
      expect(await dumpDestLayout(prismaOf(db({ version: "16", image, status: "RUNNING", pgParentMount: true })), "d1")).toEqual({ ok: true });
    }
  });

  it("a PostgreSQL 18+ row that already ran under the old mount is refused", async () => {
    for (const status of ["RUNNING", "STOPPED"]) {
      expect(await dumpDestLayout(prismaOf(db({ version: "18", image: "postgres:18", status })), "d1")).toEqual({ ok: false, reason: DUMP_DEST_PG_LAYOUT_TEXT });
    }
  });

  it("older majors, other engines and a missing row are accepted", async () => {
    expect(await dumpDestLayout(prismaOf(db({ version: "17", status: "RUNNING" })), "d1")).toEqual({ ok: true });
    expect(await dumpDestLayout(prismaOf(db({ engine: "MARIADB", version: "11", image: "mariadb:11", status: "RUNNING" })), "d1")).toEqual({ ok: true });
    expect(await dumpDestLayout(prismaOf(null), "d1")).toEqual({ ok: true });
  });
});

describe("dbGates (the physical copy) into a PostgreSQL 18+ destination", () => {
  const inv = { itemRef: "volume:s:db:data", found: true, mountType: "volume" as const, rawBytes: 1, entries: 1, specials: { sockets: 0, fifos: 0, devices: 0 }, running: false, exitCode: 0, pgMajor: "18", pgLayout: "root" as const, mountDest: "/var/lib/postgresql/data" };

  it("a layout that would pass is refused, because the cluster lives under <major>/docker of the volume", async () => {
    const gates = await dbGates(prismaOf(db({ version: "18", image: "postgres:18", pgParentMount: true })), { resourceId: "d1", credentialsCarried: true }, { ...inv, image: "postgres:18" });
    expect(gates.find((g) => g.id === "layout")).toEqual({ id: "layout", status: "fail", text: PHYSICAL_DEST_PG18_TEXT });
  });

  it("a version-16 row on a postgres:18 image is still a PostgreSQL 18 destination", async () => {
    const gates = await dbGates(prismaOf(db({ version: "16", image: "postgres:18", pgParentMount: true })), { resourceId: "d1", credentialsCarried: true }, { ...inv, image: "postgres:18" });
    expect(gates.find((g) => g.id === "layout")).toEqual({ id: "layout", status: "fail", text: PHYSICAL_DEST_PG18_TEXT });
  });

  it("a PostgreSQL 16 destination is unaffected", async () => {
    const gates = await dbGates(prismaOf(db()), { resourceId: "d1", credentialsCarried: true }, { ...inv, pgMajor: "16", image: "postgres:16" });
    expect(gates.every((g) => g.status === "pass")).toBe(true);
  });
});
