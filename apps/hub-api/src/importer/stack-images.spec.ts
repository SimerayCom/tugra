import { stackImagesOf } from "./stack-images";
import { loadServiceFixtures } from "./testing/service-fixtures";
import type { ForeignService } from "./foreign-fleet";

describe("stackImagesOf: the image every kept member of a stack is written with", () => {
  it("lists each member's source image (floating and moving alike), by stack, sorted; a stack with an image already on a digest leaves that member out", () => {
    const svc: ForeignService = {
      sourceRef: "svc00001",
      name: "t",
      serverRef: "srv-a",
      memberApps: [],
      memberDbs: [],
      composeFile: `services:\n  app:\n    image: ghcr.io/x/app:latest\n  db:\n    image: postgres:16-alpine\n  pinned:\n    image: x/p:1@sha256:${"2".repeat(64)}\n`,
    } as never;
    expect(stackImagesOf({ services: [svc] })).toEqual([
      { itemRef: "service:srv-a:svc00001", images: [{ member: "app", image: "ghcr.io/x/app:latest" }, { member: "db", image: "postgres:16-alpine" }] },
    ]);
  });
  it("a stack the plan cannot read (no compose) and a fleet with no stacks list nothing", () => {
    expect(stackImagesOf({ services: [{ sourceRef: "x", name: "n", memberApps: [], memberDbs: [] } as never] })).toEqual([]);
    expect(stackImagesOf({ services: [] })).toEqual([]);
  });
  it("covers every real service shape without throwing, and never carries a digest or a value", () => {
    const out = stackImagesOf({ services: loadServiceFixtures().map((f) => f.svc) });
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) for (const m of s.images) expect(m.image).not.toContain("@sha256:");
  });
});
