import { describe, it, expect } from "vitest";
import { startBlock, startLabel, type StartInput } from "./launch-start";

const scopeOf = (kinds: Record<string, "in-place" | "other-server">) => ({ placed: Object.fromEntries(Object.keys(kinds).map((r, i) => [r, `srv${i + 1}`])), placementKind: kinds });
const ready: StartInput = { scope: scopeOf({ a: "in-place" }), replanning: false, consentMissing: false, runnable: 3, unackedCount: 0, missingTargets: 0 };

describe("what the start button says", () => {
  it("names the servers it moves in place", () => {
    expect(startLabel({ scope: scopeOf({ a: "in-place" }) })).toEqual({ key: "migrationRun.launch.start.inPlaceOne", params: { count: 1 } });
    expect(startLabel({ scope: scopeOf({ a: "in-place", b: "in-place", c: "in-place", d: "in-place", e: "in-place", f: "in-place" }) })).toEqual({ key: "migrationRun.launch.start.inPlaceMany", params: { count: 6 } });
  });
  it("names the one target of a copy, or counts the targets", () => {
    expect(startLabel({ scope: { placed: { a: "srv1", b: "srv1" }, placementKind: { a: "other-server", b: "other-server" } }, targetName: "Server A" })).toEqual({ key: "migrationRun.launch.start.toServer", params: { server: "Server A" } });
    expect(startLabel({ scope: scopeOf({ a: "other-server", b: "other-server" }) })).toEqual({ key: "migrationRun.launch.start.toServers", params: { count: 2 } });
  });
  it("counts both kinds of a mixed move", () => {
    expect(startLabel({ scope: scopeOf({ a: "in-place", b: "other-server", c: "in-place" }) })).toEqual({ key: "migrationRun.launch.start.mixed", params: { copy: 1, inPlace: 2 } });
  });
  it("is generic with no first-step choice", () => {
    expect(startLabel({ scope: null }).key).toBe("migrationRun.launch.start.generic");
  });
});

describe("why the start button is off", () => {
  it("is null when everything is answered", () => {
    expect(startBlock(ready)).toBeNull();
  });
  it("says the first thing the owner can fix, with where to go", () => {
    expect(startBlock({ ...ready, replanning: true })).toEqual({ key: "migrationRun.launch.start.why.reading", params: {} });
    expect(startBlock({ ...ready, consentMissing: true, unackedCount: 2 })?.anchor).toBe("import-consent");
    expect(startBlock({ ...ready, unackedCount: 2, missingTargets: 1 })).toEqual({ key: "migrationRun.launch.start.why.warnings", params: { count: 2 }, anchor: "import-env-blockers" });
    expect(startBlock({ ...ready, missingTargets: 1 })).toEqual({ key: "migrationRun.launch.start.why.services", params: { count: 1 }, anchor: "import-services" });
    expect(startBlock({ ...ready, runnable: 0 })).toEqual({ key: "migrationRun.launch.start.why.nothing", params: {} });
  });
});
