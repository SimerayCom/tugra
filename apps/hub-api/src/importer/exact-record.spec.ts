import { pinComposeMembers, pinComposeMembersDetailed, restoreSourceImage } from "./exact-record";

const D = (c: string) => `sha256:${c.repeat(64)}`;

describe("pinComposeMembers: every member of a stack, however many, and several members on one image", () => {
  it("pins 90 members of one stack (nothing past 64 is skipped)", () => {
    const compose = "services:\n" + Array.from({ length: 90 }, (_, i) => `  m${i}:\n    image: x/img:latest\n`).join("");
    const members = Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`m${i}`, `x/img:latest@${D("a")}`]));
    const out = pinComposeMembers(compose, members)!;
    expect(out.match(/@sha256:a{64}/g)).toHaveLength(90);
  });
  it("members that share one image each get the digest their own container runs, even when the two differ", () => {
    const compose = "services:\n  web:\n    image: ghost:5\n  worker:\n    image: ghost:5\n";
    const out = pinComposeMembers(compose, { web: `ghost:5@${D("1")}`, worker: `ghost:5@${D("2")}` })!;
    expect(out).toContain(`image: ghost:5@${D("1")}`);
    expect(out).toContain(`image: ghost:5@${D("2")}`);
  });
  it("names the members the pin cannot replace (another repository) and leaves them as they are", () => {
    const r = pinComposeMembersDetailed("services:\n  db:\n    image: mariadb:11\n  web:\n    image: nginx:1\n", { db: `postgres:16@${D("1")}`, web: `nginx:1@${D("2")}` });
    expect(r.refused).toEqual(["db"]);
    expect(r.compose).toContain("image: mariadb:11");
    expect(r.compose).toContain(`image: nginx:1@${D("2")}`);
  });
});

describe("restoreSourceImage: unticking puts the image the source writes back, and only over the pin this run wrote", () => {
  const mk = (app: unknown, db: unknown = null) => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) }, database: { findUnique: jest.fn().mockResolvedValue(db) } };
    const apps = { setSource: jest.fn(), setComposeFile: jest.fn() };
    const databases = { setImage: jest.fn().mockResolvedValue({ changed: true }) };
    return { deps: { prisma, apps, databases } as never, apps, databases };
  };
  const pin = `getmeili/meilisearch:latest@${D("1")}`;
  it("an app on the pin goes back to the tag; one the operator changed since is left alone", async () => {
    const a = mk({ source: "IMAGE", image: pin });
    expect(await restoreSourceImage(a.deps, "u1", { kind: "app", id: "a1", from: pin, to: "getmeili/meilisearch:latest" })).toEqual({ restored: true });
    expect(a.apps.setSource).toHaveBeenCalledWith("u1", "a1", { image: "getmeili/meilisearch:latest" });
    const b = mk({ source: "IMAGE", image: `getmeili/meilisearch:latest@${D("9")}` });
    expect(await restoreSourceImage(b.deps, "u1", { kind: "app", id: "a1", from: pin, to: "getmeili/meilisearch:latest" })).toEqual({ restored: false });
    expect(b.apps.setSource).not.toHaveBeenCalled();
  });
  it("a database that was never started goes back; a started one cannot", async () => {
    const a = mk(null, { image: `postgres:16-alpine@${D("1")}`, status: "NEW" });
    expect(await restoreSourceImage(a.deps, "u1", { kind: "database", id: "d1", from: `postgres:16-alpine@${D("1")}`, to: "postgres:16-alpine" })).toEqual({ restored: true });
    const b = mk(null, { image: `postgres:16-alpine@${D("1")}`, status: "RUNNING" });
    expect(await restoreSourceImage(b.deps, "u1", { kind: "database", id: "d1", from: `postgres:16-alpine@${D("1")}`, to: "postgres:16-alpine" })).toEqual({ restored: false });
    expect(b.databases.setImage).not.toHaveBeenCalled();
  });
  it("the members of a stack that still hold the run's pin go back, the others stay", async () => {
    const a = mk({ source: "COMPOSE", composeFile: `services:\n  web:\n    image: ghost:5@${D("1")}\n  db:\n    image: postgres:16@${D("9")}\n` });
    expect(await restoreSourceImage(a.deps, "u1", { kind: "service", id: "s1", members: { web: { from: `ghost:5@${D("1")}`, to: "ghost:5" }, db: { from: `postgres:16@${D("2")}`, to: "postgres:16" } } })).toEqual({ restored: true });
    const written = a.apps.setComposeFile.mock.calls[0][2] as string;
    expect(written).toContain("image: ghost:5\n");
    expect(written).toContain(`image: postgres:16@${D("9")}`);
  });
});
