import { describe, it, expect } from "vitest";
import { BLOCKER_REGISTRY, WARNING_REGISTRY, blockerSpec, canAccept, decisionOf, hasAppImages, isAckableKey, memberPinEntries, pinDraftOf, pinEntriesOf, pinRefOf, summaryOf, warningKey, warningSpec, GENERIC_BLOCKER } from "./dry-run-decision";
import { mkStep } from "../components/migration-run/test-fixtures";
import en from "../i18n/locales/en";
import type { MigrationRunDryRunItem, MigrationRunStepKey } from "./types";

const lookup = (dotted: string): unknown => dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), en);
const steps = (by: Partial<Record<MigrationRunStepKey, MigrationRunDryRunItem[]>>) =>
  (Object.entries(by) as Array<[MigrationRunStepKey, MigrationRunDryRunItem[]]>).map(([k, dryRun]) => mkStep(k, "PASSED", { progress: { done: 0, total: dryRun.length, unit: "item", dryRun } }));

describe("warningKey", () => {
  it("is the code, plus the risk for a code that carries one", () => {
    expect(warningKey({ code: "data-seed.volume-excluded" })).toBe("data-seed.volume-excluded");
    expect(warningKey({ code: "import.risk-warning", params: { risk: "service.image.floating", count: 2 } })).toBe("import.risk-warning:service.image.floating");
    expect(warningKey({ code: "import.item-skipped", params: { risk: "app.env.unresolved" } })).toBe("import.item-skipped:app.env.unresolved");
    expect(warningKey({ code: "dns-prepare.dry.would-lower-ttl", params: { risk: "x" } })).toBe("dns-prepare.dry.would-lower-ttl"); // only codes that carry a risk
  });
  it("only a well-formed key can be accepted", () => {
    expect(isAckableKey("import.risk-warning:service.image.floating")).toBe(true);
    expect(isAckableKey("Bad Key")).toBe(false);
    expect(isAckableKey("a")).toBe(false);
    expect(isAckableKey(`a.${"b".repeat(130)}`)).toBe(false);
  });
});

describe("decisionOf", () => {
  it("is clean when nothing but info was projected", () => {
    const d = decisionOf({ steps: steps({ IMPORT: [{ code: "import.projection", level: "info", params: { apps: 1, databases: 0, services: 0 } }] }) });
    expect(d).toMatchObject({ verdict: "clean", blockers: [], warnings: [], open: [] });
  });

  it("block and unknown stop the real run; warn does not", () => {
    const run = { steps: steps({ PREFLIGHT: [{ code: "preflight.disk-low", level: "block", subject: "a" }, { code: "tls-preissue.acme-email", level: "unknown" }], IMPORT: [{ code: "x.warn", level: "warn" }] }) };
    const d = decisionOf(run);
    expect(d.verdict).toBe("blocked");
    expect(d.blockers.map((b) => b.code)).toEqual(["preflight.disk-low", "tls-preissue.acme-email"]);
    expect(d.warnings.map((w) => w.code)).toEqual(["x.warn"]);
  });

  it("folds one warning raised many times into one issue with every subject, once", () => {
    const item = (subject: string): MigrationRunDryRunItem => ({ code: "data-seed.volume-excluded", level: "warn", subject });
    const d = decisionOf({ steps: steps({ DATA_SEED: [item("v1"), item("v2"), item("v1")] }) });
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatchObject({ key: "data-seed.volume-excluded", count: 3, subjects: ["v1", "v2"], step: "DATA_SEED" });
  });

  it("keeps two risks of the same code apart, and a blocker apart from a warning of the same code", () => {
    const risk = (r: string): MigrationRunDryRunItem => ({ code: "import.risk-warning", level: "warn", params: { risk: r, count: 1, items: ["a"] } });
    const d = decisionOf({ steps: steps({ IMPORT: [risk("service.image.floating"), risk("app.git.private"), { code: "import.risk-warning", level: "block" }] }) });
    expect(d.warnings.map((w) => w.key).sort()).toEqual(["import.risk-warning:app.git.private", "import.risk-warning:service.image.floating"]);
    expect(d.blockers).toHaveLength(1);
  });

  it("a warning the hub cannot store is shown but never holds Start back", () => {
    const d = decisionOf({ steps: steps({ IMPORT: [{ code: "Bad Code", level: "warn" }] }) });
    expect(d.warnings).toHaveLength(1);
    expect(d.open).toHaveLength(0);
    expect(d.verdict).toBe("clean");
  });

  it("accepted warnings stop counting as open; accepting every one makes it clean", () => {
    const run = { steps: steps({ IMPORT: [{ code: "import.risk-warning", level: "warn", params: { risk: "service.image.floating" } }, { code: "data-seed.volume-excluded", level: "warn" }] }) };
    const none = decisionOf(run);
    expect(none.verdict).toBe("warnings");
    expect(none.open).toHaveLength(2);
    const one = decisionOf(run, ["data-seed.volume-excluded"]);
    expect(one.verdict).toBe("warnings");
    expect(one.open.map((w) => w.key)).toEqual(["import.risk-warning:service.image.floating"]);
    const all = decisionOf(run, ["data-seed.volume-excluded", "import.risk-warning:service.image.floating"]);
    expect(all.verdict).toBe("clean");
    expect(all.accepted).toHaveLength(2);
  });

  it("an acceptance never clears a blocker", () => {
    const d = decisionOf({ steps: steps({ PREFLIGHT: [{ code: "preflight.disk-low", level: "block" }] }) }, ["preflight.disk-low"]);
    expect(d.verdict).toBe("blocked");
  });
});

describe("summaryOf", () => {
  const vol = (rawBytes: number): MigrationRunDryRunItem => ({ code: "data-seed.dry.volume", level: "info", subject: "v", params: { rawBytes, entries: 1, running: false } });

  it("reads what moves, the data size, the window and the duration the dry run projected", () => {
    const s = summaryOf({
      steps: steps({
        IMPORT: [{ code: "import.projection", level: "info", params: { apps: 4, databases: 2, services: 1 } }],
        DATA_SEED: [vol(100), vol(50), { code: "data-seed.estimate", level: "info", params: { seconds: 300, bytes: 2048, warmSeconds: 120 } }],
      }),
    });
    expect(s).toEqual({ apps: 4, databases: 2, services: 1, dataBytes: 2048, downtimeSec: 300, durationSec: 420 });
  });

  it("without the hub's total it sums the volumes and the dump sizes; without an estimate it says nothing", () => {
    const s = summaryOf({ steps: steps({ DATA_SEED: [vol(100), vol(50), { code: "data-seed.dry.db-lane", level: "info", params: { dumpBytes: 25 } }] }) });
    expect(s).toMatchObject({ dataBytes: 175, downtimeSec: null, durationSec: null, apps: null });
  });

  it("an estimate that could not be made stays unknown, and so does the duration", () => {
    const s = summaryOf({ steps: steps({ DATA_SEED: [{ code: "data-seed.estimate", level: "unknown", params: { seconds: null, bytes: 10, warmSeconds: 5 } }] }) });
    expect(s).toMatchObject({ dataBytes: 10, downtimeSec: null, durationSec: null });
  });

  it("nothing projected: every figure is null, never a zero that looks measured", () => {
    expect(summaryOf({ steps: [] })).toEqual({ apps: null, databases: null, services: null, dataBytes: null, downtimeSec: null, durationSec: null });
  });
});

describe("registries", () => {
  it("an unknown warning has no spec but can still be accepted; an unknown blocker gets the generic advice", () => {
    expect(warningSpec("nobody.wrote.this")).toEqual({});
    expect(canAccept("nobody.wrote.this")).toBe(true);
    expect(canAccept("Bad Key")).toBe(false);
    expect(blockerSpec("nobody.wrote.this")).toBe(GENERIC_BLOCKER);
  });

  it("every string a registry entry points at exists in the locale", () => {
    const keys: string[] = [];
    for (const w of Object.values(WARNING_REGISTRY)) keys.push(...[w.titleKey, w.hintKey, w.fix?.labelKey].filter((k): k is string => !!k));
    for (const b of [...Object.values(BLOCKER_REGISTRY), GENERIC_BLOCKER]) keys.push(b.adviceKey, ...(b.fix ? [b.fix.labelKey] : []));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(typeof lookup(k), k).toBe("string");
  });

  it("every fix links inside the app", () => {
    for (const w of Object.values(WARNING_REGISTRY)) if (w.fix?.kind === "link") expect(w.fix.href.startsWith("/")).toBe(true);
  });

  it("every registered warning key is a key the hub accepts", () => {
    for (const k of Object.keys(WARNING_REGISTRY)) expect(isAckableKey(k), k).toBe(true);
  });
});

describe("decisionOf: fixed warnings", () => {
  const run = { steps: steps({ IMPORT: [{ code: "import.risk-warning", level: "warn", params: { risk: "service.image.floating" } }, { code: "x.warn", level: "warn" }] }) };
  it("a warning the hub reports as fixed is not open and not accepted", () => {
    const d = decisionOf(run, [], ["import.risk-warning:service.image.floating"]);
    expect(d.open.map((w) => w.key)).toEqual(["x.warn"]);
    expect(d.fixed.map((w) => w.key)).toEqual(["import.risk-warning:service.image.floating"]);
    expect(d.accepted).toEqual([]);
    expect(decisionOf(run, ["x.warn"], ["import.risk-warning:service.image.floating"]).verdict).toBe("clean");
  });
  it("without any fixed key nothing changes", () => {
    expect(decisionOf(run, []).open).toHaveLength(2);
    expect(decisionOf(run, []).fixed).toEqual([]);
  });
});

describe("the floating images of a warning", () => {
  const params = { imageCount: 3, imageItems: ["service:s:a", "service:s:a", "app:s:b"], imageMembers: ["meili", "web", ""], images: ["getmeili/meilisearch:latest", "ghcr.io/acme/web", "img/proxy:latest"], imageSeen: ["getmeili/meilisearch:v1.8.0", "", ""] };
  it("reads the index-aligned params, splitting stack members from image apps", () => {
    expect(pinEntriesOf(params)).toHaveLength(3);
    expect(memberPinEntries(params).map((e) => e.member)).toEqual(["meili", "web"]);
    expect(hasAppImages(params)).toBe(true);
    expect(hasAppImages({ ...params, imageItems: ["a"], imageMembers: ["m"], images: ["x"], imageSeen: [""] })).toBe(false);
  });
  it("reads nothing from params that are missing or do not line up", () => {
    expect(pinEntriesOf(undefined)).toEqual([]);
    expect(pinEntriesOf({ ...params, imageSeen: [""] })).toEqual([]);
    expect(pinEntriesOf({ ...params, images: "x" as never })).toEqual([]);
  });
});

describe("pinRefOf / pinDraftOf", () => {
  const IMG = "getmeili/meilisearch:latest";
  it("a version tag or a digest becomes a ref of the same repository", () => {
    expect(pinRefOf(IMG, "v1.8.0")).toBe("getmeili/meilisearch:v1.8.0");
    expect(pinRefOf(IMG, ` 1.8 `)).toBe("getmeili/meilisearch:1.8");
    expect(pinRefOf("ghcr.io:5000/acme/web", `sha256:${"a".repeat(64)}`)).toBe(`ghcr.io:5000/acme/web@sha256:${"a".repeat(64)}`);
  });
  it("latest, empty and malformed are not pins; a full ref must be the same repository and not floating", () => {
    for (const bad of ["", "  ", "latest", "a b", "sha256:short", "-x"]) expect(pinRefOf(IMG, bad), bad).toBeNull();
    expect(pinRefOf(IMG, "getmeili/meilisearch:v1")).toBe("getmeili/meilisearch:v1");
    expect(pinRefOf(IMG, "evil/meilisearch:v1")).toBeNull();
    expect(pinRefOf(IMG, "getmeili/meilisearch:latest")).toBeNull();
    expect(pinRefOf(IMG, "getmeili/meilisearch")).toBeNull();
    expect(pinRefOf("redis:latest", "redis:7")).toBe("redis:7");
  });
  it("the draft is the tag or digest of what the source shows", () => {
    expect(pinDraftOf("getmeili/meilisearch:v1.8.0")).toBe("v1.8.0");
    expect(pinDraftOf(`repo@sha256:${"b".repeat(64)}`)).toBe(`sha256:${"b".repeat(64)}`);
    expect(pinDraftOf("registry:5000/repo")).toBe("");
    expect(pinDraftOf("")).toBe("");
  });
});
