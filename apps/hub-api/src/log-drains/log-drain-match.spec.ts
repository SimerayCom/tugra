import * as fs from "node:fs";
import * as path from "node:path";
import { drainMatchAllows, resolveAppMatch, resolveServerMatch } from "./log-drain-match";

// The SAME fixture the Go matcher test consumes (agent/internal/drains/match_test.go): the two implementations
// cannot drift apart without one of the suites failing.
const FIXTURE = path.resolve(__dirname, "../../../../agent/internal/drains/testdata/match_cases.json");

interface Scenario {
  name: string;
  appId: string;
  services: string[];
  cases: { container: string; want: boolean }[];
}

describe("resolveAppMatch", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { scenarios: Scenario[] };

  it("loads the shared fixture", () => {
    expect(fixture.scenarios.length).toBeGreaterThanOrEqual(3);
  });

  for (const sc of JSON.parse(fs.readFileSync(FIXTURE, "utf8")).scenarios as Scenario[]) {
    it(`matches the fixture scenario: ${sc.name}`, () => {
      const m = resolveAppMatch(sc.appId, sc.services);
      for (const c of sc.cases) expect([c.container, drainMatchAllows(m, c.container)]).toEqual([c.container, c.want]);
    });
  }

  it("builds the exact selector shapes", () => {
    expect(resolveAppMatch("a1", [])).toEqual({
      names: ["tugra_a1", "tugra_a1__rollout"],
      prefixes: ["tugra_a1-", "tugra_a1."],
      svcPrefixes: [],
      globs: [],
    });
    expect(resolveAppMatch("a1", ["web", "worker"])).toEqual({
      names: [],
      prefixes: [],
      svcPrefixes: ["tugra_a1-web-", "tugra_a1-worker-"],
      globs: [],
    });
  });

  it("service web does not match web-2 but matches web-12 (digits-only remainder rule)", () => {
    const m = resolveAppMatch("a1", ["web"]);
    expect(drainMatchAllows(m, "tugra_a1-web-1")).toBe(true);
    expect(drainMatchAllows(m, "tugra_a1-web-12")).toBe(true);
    expect(drainMatchAllows(m, "tugra_a1-web-2-1")).toBe(false);
  });
});

describe("resolveServerMatch", () => {
  it("is undefined without globs (no filter) and a globs-only selector otherwise", () => {
    expect(resolveServerMatch([])).toBeUndefined();
    const m = resolveServerMatch(["tugra_db_*"])!;
    expect(m).toEqual({ names: [], prefixes: [], svcPrefixes: [], globs: ["tugra_db_*"] });
    expect(drainMatchAllows(m, "tugra_db_abc")).toBe(true);
    expect(drainMatchAllows(m, "tugra_app")).toBe(false);
  });
});
