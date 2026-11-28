import { exactPinOf, exactRows, isExactOff, itemRefOfKey, memberKey, withExactPins } from "./exact-images";
import { exactDueOf, pinExactImages } from "./op-safety";
import { floatingImages } from "./image-pins";
import { imagesFixed } from "../../../core/dry-run-warnings";
import type { RunHint } from "./run-hints";
import type { OpSnapshot } from "../import-ports";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const SVC = "service:s:z";
const exact = (key: string, value: string): RunHint => ({ kind: "exact-image", key, scope: "", value, evidence: "host-loop-reported" });
const off = (key: string, value = "off"): RunHint => ({ kind: "exact-off", key, scope: "", value, evidence: "operator-attested" });

const HINTS: RunHint[] = [
  exact("app:s:a", `getmeili/meilisearch:latest@${D1} 1.12.3`),
  exact("database:s:d", `postgres:16-alpine@${D2}`),
  exact(memberKey(SVC, "meili"), `getmeili/meilisearch:latest@${D1}`),
  exact(memberKey(SVC, "cache"), `redis:7.2@${D2}`),
];

describe("exactRows / exactPinOf / isExactOff", () => {
  it("lists every recorded exact image with its itemRef, member, tag, version and digest, in a stable order", () => {
    expect(exactRows(HINTS).map((r) => [r.itemRef, r.member, r.tag, r.version, r.digest, r.kept])).toEqual([
      ["app:s:a", "", "latest", "1.12.3", D1, true],
      ["database:s:d", "", "16-alpine", null, D2, true],
      [SVC, "cache", "7.2", null, D2, true],
      [SVC, "meili", "latest", null, D1, true],
    ]);
    expect(itemRefOfKey(memberKey(SVC, "meili"))).toBe(SVC);
    expect(itemRefOfKey("app:s:a")).toBe("app:s:a");
  });
  it("an item the owner unticked is listed as not kept and has no pin; ticking it again (`on`) brings it back", () => {
    expect(exactPinOf([...HINTS, off("app:s:a")], "app:s:a")).toBeNull();
    expect(exactRows([...HINTS, off("app:s:a")]).find((r) => r.itemRef === "app:s:a")?.kept).toBe(false);
    expect(isExactOff([off("app:s:a", "on")], "app:s:a")).toBe(false);
    expect(exactPinOf([...HINTS, off("app:s:a", "on")], "app:s:a")?.ref).toBe(`getmeili/meilisearch:latest@${D1}`);
    expect(exactPinOf(HINTS, SVC, "cache")?.ref).toBe(`redis:7.2@${D2}`);
    expect(exactPinOf(HINTS, SVC, "nope")).toBeNull();
  });
  it("a value that is not a plain ref is ignored", () => {
    expect(exactRows([exact("app:s:x", "x/y; id")])).toEqual([]);
  });
});

describe("withExactPins: the pins ride in the apply input, never in the plan hash", () => {
  const base: { sourceKind: "coolify"; sessionId: string; targetServerId: string; planHash: string; serviceChoices?: Record<string, import("../../../../importer/dto").ServiceChoice>; imagePins?: Record<string, string> } = { sourceKind: "coolify", sessionId: "s1", targetServerId: "t1", planHash: "a".repeat(32) };
  it("writes a member's pin into its stack's choice and an app's / database's into imagePins", () => {
    const out = withExactPins(base, HINTS) as Record<string, unknown>;
    expect(out.planHash).toBe(base.planHash);
    expect(out.imagePins).toEqual({ "app:s:a": `getmeili/meilisearch:latest@${D1}`, "database:s:d": `postgres:16-alpine@${D2}` });
    expect(out.serviceChoices).toEqual({ [SVC]: { pins: { cache: `redis:7.2@${D2}`, meili: `getmeili/meilisearch:latest@${D1}` } } });
  });
  it("with no hints the input is returned untouched (same object): a plan with no digests behaves exactly as before", () => {
    expect(withExactPins(base, [])).toBe(base);
    expect(withExactPins(base, [off("app:s:a")])).toBe(base);
  });
  it("the opt-out holds: an unticked item is not written, the others are", () => {
    const out = withExactPins(base, [...HINTS, off("app:s:a"), off(SVC)]) as Record<string, unknown>;
    expect(out.imagePins).toEqual({ "database:s:d": `postgres:16-alpine@${D2}` });
    expect(out.serviceChoices).toBeUndefined();
  });
  it("never overrides what the caller wrote: an owner's own pin, a stack that disables pinning, a skipped stack, an app pin", () => {
    const out = withExactPins({ ...base, imagePins: { "app:s:a": "getmeili/meilisearch:v1.0.0" }, serviceChoices: { [SVC]: { pinImages: false } } }, HINTS) as Record<string, unknown>;
    expect((out.imagePins as Record<string, string>)["app:s:a"]).toBe("getmeili/meilisearch:v1.0.0");
    expect(out.serviceChoices).toEqual({ [SVC]: { pinImages: false } });
    const own = withExactPins({ ...base, serviceChoices: { [SVC]: { pins: { meili: "getmeili/meilisearch:v1.12.0" } } } }, HINTS) as { serviceChoices: Record<string, { pins: Record<string, string> }> };
    expect(own.serviceChoices[SVC].pins).toEqual({ meili: "getmeili/meilisearch:v1.12.0", cache: `redis:7.2@${D2}` });
    expect(withExactPins({ ...base, serviceChoices: { [SVC]: { skip: true } } }, [exact(memberKey(SVC, "cache"), `redis:7.2@${D2}`)])).toEqual({ ...base, serviceChoices: { [SVC]: { skip: true } } });
  });
  it("does not exceed the importer's 64 stack choices", () => {
    const choices = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`service:s:x${i}`, { pinImages: true }]));
    const out = withExactPins({ ...base, serviceChoices: choices }, [exact(memberKey("service:s:late", "m"), `x/y:1@${D1}`)]) as Record<string, unknown>;
    expect(Object.keys(out.serviceChoices as object)).toHaveLength(64);
  });
});

describe("the gate counts an exact image as a pin", () => {
  it("floatingImages marks an app and a stack member pinned by an exact hint (and unpinned without or after an opt-out)", () => {
    const items = [
      { itemRef: "app:s:a", kind: "app", name: "api", proposed: { source: "IMAGE", image: "getmeili/meilisearch:latest" } },
      { itemRef: SVC, kind: "service", name: "stack", proposed: { imageFloating: ["meili"] } },
    ];
    const rows = [{ itemRef: SVC, floating: [{ member: "meili", image: "getmeili/meilisearch:latest" }] }];
    expect(floatingImages(items as never, {}, [], rows).map((f) => f.pinned)).toEqual([false, false]);
    expect(floatingImages(items as never, {}, HINTS, rows).map((f) => f.pinned)).toEqual([true, true]);
    expect(floatingImages(items as never, {}, [...HINTS, off("app:s:a"), off(SVC)], rows).map((f) => f.pinned)).toEqual([false, false]);
  });
  it("a dry-run warning about floating images is fixed once every image behind it has an exact image", () => {
    const params = { imageCount: 2, imageItems: ["app:s:a", SVC], imageMembers: ["", "meili"], images: ["getmeili/meilisearch:latest", "getmeili/meilisearch:latest"], imageSeen: ["", ""] };
    expect(imagesFixed(params, [HINTS[0]])).toBe(false);
    expect(imagesFixed(params, HINTS)).toBe(true);
  });
});

describe("exactDueOf / pinExactImages: what is written into the records the import created", () => {
  const op = (tasks: OpSnapshot["tasks"]): OpSnapshot => ({ id: "op1", rolledBack: false, cancelRequestedAt: null, cancelRequested: false, tasks, planItems: [] }) as unknown as OpSnapshot;
  const task = (itemRef: string, kind: string, resourceType: string, id: string, status = "DONE") => ({ itemRef, kind, status, resourceType, resourceId: id, name: id, gitStatus: null });
  const tasks = [task("app:s:a", "app", "application", "A1"), task("database:s:d", "database", "database", "D1"), task(SVC, "service", "application", "S1"), task("app:s:none", "app", "application", "A2"), task("app:s:late", "app", "application", "A3", "PENDING")];

  it("an app, a database and a stack, each with the refs recorded for it; an item without a recorded image and a task that is not DONE are not due", () => {
    const due = exactDueOf(op(tasks), [...HINTS, exact("app:s:late", `x/y:1@${D1}`)]);
    expect(due).toEqual([
      { kind: "app", itemRef: "app:s:a", name: "A1", id: "A1", ref: `getmeili/meilisearch:latest@${D1}` },
      { kind: "database", itemRef: "database:s:d", name: "D1", id: "D1", ref: `postgres:16-alpine@${D2}` },
      { kind: "service", itemRef: SVC, name: "S1", id: "S1", members: { cache: `redis:7.2@${D2}`, meili: `getmeili/meilisearch:latest@${D1}` } },
    ]);
  });
  it("an item the owner opted out of is not due", () => {
    expect(exactDueOf(op(tasks), [...HINTS, off("app:s:a"), off(SVC)]).map((d) => d.itemRef)).toEqual(["database:s:d"]);
  });
  it("pinExactImages hands each due record to the port and reports the names it changed; a port that cannot pin changes nothing", async () => {
    const pinExactImage = jest.fn().mockImplementation(async (_u: string, t: { id: string }) => ({ pinned: t.id !== "D1" }));
    expect(await pinExactImages({ pinExactImage }, "u1", op(tasks), HINTS)).toEqual(["A1", "S1"]);
    expect(pinExactImage).toHaveBeenCalledTimes(3);
    expect(await pinExactImages({}, "u1", op(tasks), HINTS)).toEqual([]);
    expect(await pinExactImages({ pinExactImage }, "u1", op(tasks), [])).toEqual([]);
  });
});
