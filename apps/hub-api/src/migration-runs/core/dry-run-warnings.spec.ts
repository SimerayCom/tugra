import { fixedKeys, imagesFixed, isAckableKey, openWarnings, warningKeyOf, warningKeysOf, warningsOf } from "./dry-run-warnings";
import { imageParams } from "../steps/import/baseline/image-pins";
import type { RunHint } from "../steps/import/baseline/run-hints";

const D = `sha256:${"b".repeat(64)}`;
const hint = (kind: RunHint["kind"], key: string, value = "accepted", scope = ""): RunHint => ({ kind, key, scope, value, evidence: "operator-attested" });
const step = (...items: Array<Record<string, unknown>>) => ({ progress: { dryRun: items } });
const warn = (code: string, params?: Record<string, unknown>) => ({ code, level: "warn", ...(params ? { params } : {}) });

describe("warningKeyOf", () => {
  it("is the code, plus the risk for the codes that carry one", () => {
    expect(warningKeyOf({ code: "import.risk-warning", params: { risk: "app.git.private" } })).toBe("import.risk-warning:app.git.private");
    expect(warningKeyOf({ code: "import.item-skipped", params: { risk: "x.y" } })).toBe("import.item-skipped:x.y");
    expect(warningKeyOf({ code: "data-seed.volume-excluded", params: { risk: "ignored" } })).toBe("data-seed.volume-excluded");
    expect(warningKeyOf({ code: "import.risk-warning" })).toBe("import.risk-warning");
  });
  it("a key the hub cannot store is not ackable", () => {
    expect(isAckableKey("a.b")).toBe(true);
    expect(isAckableKey("A B")).toBe(false);
    expect(isAckableKey("ab")).toBe(false);
  });
});

describe("warningsOf / warningKeysOf", () => {
  it("lists only warn items, across steps, and tolerates empty or odd progress", () => {
    const steps = [step(warn("a.one"), { code: "a.two", level: "info" }, { code: "a.three", level: "block" }), { progress: null }, { progress: { dryRun: "x" } }, step(warn("b.one", { risk: "r" }))];
    expect(warningsOf(steps).map((w) => w.key)).toEqual(["a.one", "b.one"]);
    expect([...warningKeysOf(steps)].sort()).toEqual(["a.one", "b.one"]);
  });
});

describe("openWarnings", () => {
  const steps = [step(warn("a.one"), warn("import.risk-warning", { risk: "app.git.private" }), warn("Bad Code"))];
  it("is every storable warning nobody accepted", () => {
    expect(openWarnings(steps, [])).toEqual(["a.one", "import.risk-warning:app.git.private"]);
  });
  it("an acceptance settles exactly its own key; a taken-back one does not exist", () => {
    expect(openWarnings(steps, [hint("warning-ack", "a.one")])).toEqual(["import.risk-warning:app.git.private"]);
    expect(openWarnings(steps, [hint("warning-ack", "a.one"), hint("warning-ack", "import.risk-warning:app.git.private")])).toEqual([]);
    expect(openWarnings(steps, [hint("image-pin", "a.one", D)])).toHaveLength(2);
  });
  it("nothing to settle on a dry run without warnings", () => {
    expect(openWarnings([step({ code: "x.y", level: "info" })], [])).toEqual([]);
    expect(openWarnings([], [])).toEqual([]);
  });
});

describe("fixed by pins", () => {
  const svc = "service:src:abc";
  const floating = (extra: Record<string, unknown> = {}) =>
    warn("import.risk-warning", {
      risk: "service.image.floating",
      ...imageParams([
        { itemRef: svc, name: "meili", kind: "service", member: "meili", image: "getmeili/meilisearch:latest", pinned: false },
        { itemRef: "app:src:app1", name: "cache", kind: "app", image: "redis:latest", pinned: false },
      ]),
      ...extra,
    });

  it("a stack member needs its service pin, an image app its digest pin", () => {
    const p = floating().params as Record<string, never>;
    expect(imagesFixed(p, [])).toBe(false);
    expect(imagesFixed(p, [hint("service-pin", `${svc}#meili`, "getmeili/meilisearch:v1")])).toBe(false);
    expect(imagesFixed(p, [hint("service-pin", `${svc}#meili`, "getmeili/meilisearch:v1"), hint("image-pin", "redis:latest", D, "src")])).toBe(true);
    expect(imagesFixed(p, [hint("service-pin", `${svc}#meili`, "getmeili/meilisearch:v1"), hint("image-pin", "redis:latest", D)])).toBe(true);
    expect(imagesFixed(p, [hint("service-pin", `${svc}#meili`, "getmeili/meilisearch:v1"), hint("image-pin", "redis:latest", D, "other-server")])).toBe(false);
  });

  it("a warning that carries no images, or a cut list, is never fixed by a pin", () => {
    expect(imagesFixed(null, [hint("service-pin", `${svc}#meili`, "a:b")])).toBe(false);
    expect(imagesFixed({ risk: "service.image.floating" }, [])).toBe(false);
    const many = imageParams(Array.from({ length: 25 }, (_, i) => ({ itemRef: svc, name: "m", kind: "service" as const, member: `m${i}`, image: "a:latest", pinned: false })));
    const hints = Array.from({ length: 25 }, (_, i) => hint("service-pin", `${svc}#m${i}`, "a:b"));
    expect(many.imageCount).toBe(25);
    expect(imagesFixed(many as never, hints)).toBe(false);
  });

  it("a fixed warning is no longer open; one unfixed item keeps its key open", () => {
    const steps = [step(floating())];
    const pins = [hint("service-pin", `${svc}#meili`, "getmeili/meilisearch:v1"), hint("image-pin", "redis:latest", D, "src")];
    expect(fixedKeys(steps, pins)).toEqual(["import.risk-warning:service.image.floating"]);
    expect(openWarnings(steps, pins)).toEqual([]);
    expect(openWarnings(steps, pins.slice(0, 1))).toEqual(["import.risk-warning:service.image.floating"]);
    expect(fixedKeys([step(floating(), warn("import.risk-warning", { risk: "service.image.floating" }))], pins)).toEqual([]);
  });
});
