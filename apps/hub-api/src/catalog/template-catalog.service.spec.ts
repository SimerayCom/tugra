import { TemplateCatalogService } from "./template-catalog.service";
import { TEMPLATES, type TemplateDef } from "../templates/catalog";
import type { PrismaService } from "../prisma/prisma.service";

const remoteTpl = (over: Partial<TemplateDef> = {}): TemplateDef => ({
  slug: "newtpl",
  name: "New",
  description: "d",
  category: "tools",
  composeFile: "services:\n  x:\n    image: y\n",
  ...over,
});

function svc(findUnique: jest.Mock): TemplateCatalogService {
  return new TemplateCatalogService({ catalogSnapshot: { findUnique } } as unknown as PrismaService);
}

describe("TemplateCatalogService", () => {
  it("serves the bundled catalog immediately (constructor, before any IO)", () => {
    const s = svc(jest.fn());
    expect(s.get("redis")).toBeTruthy();
    expect(s.metaList().length).toBe(Object.keys(TEMPLATES).length);
  });

  it("overlays the DB row on boot while keeping the bundled base", async () => {
    const s = svc(jest.fn().mockResolvedValue({ payload: { version: "9", templates: { newtpl: remoteTpl() } } }));
    await s.onModuleInit();
    expect(s.get("newtpl")?.name).toBe("New");
    expect(s.get("redis")).toBeTruthy();
  });

  it("keeps the bundled catalog when the DB is unavailable at boot (no throw, gallery intact)", async () => {
    const s = svc(jest.fn().mockRejectedValue(new Error("db down")));
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(s.get("redis")).toBeTruthy();
    expect(s.metaList().length).toBe(Object.keys(TEMPLATES).length);
  });

  it("a null row leaves the bundled catalog unchanged", async () => {
    const s = svc(jest.fn().mockResolvedValue(null));
    await s.onModuleInit();
    expect(s.metaList().length).toBe(Object.keys(TEMPLATES).length);
  });

  it("applyRemote swaps atomically and a remote slug NEVER shadows a curated one", () => {
    const s = svc(jest.fn());
    s.applyRemote({
      wordpress: remoteTpl({ slug: "wordpress", name: "EVIL" }),
      newtpl: remoteTpl(),
    });
    expect(s.get("newtpl")?.name).toBe("New"); // remote may ADD new slugs
    expect(s.get("wordpress")?.name).toBe("WordPress"); // curated WINS — remote can't override it
  });

  it("metaList never leaks composeFile / secrets", () => {
    const blob = JSON.stringify(svc(jest.fn()).metaList());
    expect(blob).not.toContain("composeFile");
    expect(blob).not.toContain("services:");
  });
});
