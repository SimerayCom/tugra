import { parseAgentRead } from "./coolify-agent-read";
import { CFYA, sectionLimits } from "./coolify-agent-sql";
import { CFY } from "./coolify-read-script";
import { CoolifyReadError } from "./coolify-inventory";

const out = (...parts: string[]) => parts.join("\n") + "\n";
const head = ["TUGRA_CFY_IMAGE ghcr.io/coollabsio/coolify:4.0.0-beta.463", "TUGRA_CFY_RO on", `${CFYA.iso}repeatable read`];
const section = (name: string, rows: unknown[]) => [`${CFY.begin}${name}`, JSON.stringify(rows), `${CFY.end}${name}`];
const fail = (text: string) => {
  try {
    parseAgentRead(text);
  } catch (e) {
    return e instanceof CoolifyReadError ? e.failure : "other";
  }
  return "no error";
};

describe("parseAgentRead", () => {
  it("parses sections, skips, the image and the schema version", () => {
    const text = out(...head, ...section("servers", [{ id: 0, uuid: "a" }]), `${CFY.skip}docker_swarm`, ...section("schema", [{ id: 4, migration: "2025_x" }]), CFY.done);
    const r = parseAgentRead(text, new Date("2026-11-26T00:00:00Z"));
    expect(r.image).toBe("ghcr.io/coollabsio/coolify:4.0.0-beta.463");
    expect(r.schemaVersion).toBe("2025_x");
    expect(r.skipped).toEqual(["docker_swarm"]);
    expect(r.sections.get("servers")).toEqual([{ id: 0, uuid: "a" }]);
    expect(r.readAt).toBe("2026-11-26T00:00:00.000Z");
  });

  it("no schema table: the version is unknown, never guessed", () => {
    expect(parseAgentRead(out(...head, `${CFY.skip}schema`, CFY.done)).schemaVersion).toBeNull();
  });

  it("refuses a session that did not confirm read-only", () => {
    expect(fail(out("TUGRA_CFY_RO off", `${CFYA.iso}repeatable read`, CFY.done))).toBe("not_read_only");
    expect(fail(out(`${CFYA.iso}repeatable read`, CFY.done))).toBe("not_read_only");
  });

  it("refuses a session that did not confirm one REPEATABLE READ snapshot (every section must see the same data)", () => {
    expect(fail(out("TUGRA_CFY_RO on", `${CFYA.iso}read committed`, CFY.done))).toBe("not_read_only");
    expect(fail(out("TUGRA_CFY_RO on", CFY.done))).toBe("not_read_only");
  });

  it("fails closed on a missing DONE marker, the FAIL marker, and a section without its END (truncated output)", () => {
    expect(fail(out(...head, ...section("servers", [])))).toBe("unreadable");
    expect(fail(out(...head, CFYA.fail))).toBe("unreadable");
    expect(fail(out(...head, ...section("servers", []), CFYA.fail, CFY.done))).toBe("unreadable");
    expect(fail(out(...head, `${CFY.begin}servers`, "[]", CFY.done))).toBe("unreadable");
  });

  it("fails closed on a section that is not a JSON array (the v1 parser would read it as empty)", () => {
    expect(fail(out(...head, `${CFY.begin}servers`, "not json", `${CFY.end}servers`, CFY.done))).toBe("unreadable");
    expect(fail(out(...head, `${CFY.begin}servers`, '{"a":1}', `${CFY.end}servers`, CFY.done))).toBe("unreadable");
    expect(fail(out(...head, `${CFY.begin}servers`, '[{"a":1}', `${CFY.end}servers`, CFY.done))).toBe("unreadable");
  });

  it("maps the host failure markers", () => {
    expect(fail(`${CFY.noDocker}\n`)).toBe("no_docker");
    expect(fail(`${CFY.noCoolify}\n`)).toBe("no_coolify");
    expect(fail(`${CFY.stopped}\n`)).toBe("db_stopped");
  });

  it("reports a section that came back with more rows than its cap as truncated (and trims the probe row), and not one that did not", () => {
    const limit = sectionLimits().teams;
    const rows = Array.from({ length: limit + 1 }, (_, i) => ({ id: i }));
    const r = parseAgentRead(out(...head, ...section("teams", rows), ...section("servers", [{ id: 1 }]), CFY.done));
    expect(r.truncated).toEqual(["teams"]);
    expect(r.sections.get("teams")).toHaveLength(limit);
  });

  it("does not call a section cut when it holds exactly its cap, or when it is a one-row table (instance, schema)", () => {
    const limit = sectionLimits().teams;
    const full = Array.from({ length: limit }, (_, i) => ({ id: i }));
    const r = parseAgentRead(out(...head, ...section("teams", full), ...section("instance", [{ id: 0, instance_name: "x" }]), ...section("schema", [{ migration: "2025_01_01_000000_x", id: 9 }]), CFY.done));
    expect(r.truncated).toEqual([]);
    expect(r.schemaVersion).toBe("2025_01_01_000000_x");
    expect(r.sections.get("instance")).toHaveLength(1);
  });

  it("a second instance row is a real cut (the cap of the instance section is one)", () => {
    const r = parseAgentRead(out(...head, ...section("instance", [{ id: 0 }, { id: 1 }]), CFY.done));
    expect(r.truncated).toEqual(["instance"]);
    expect(r.sections.get("instance")).toEqual([{ id: 0 }]);
  });

  it("drops non-object rows and never throws on hostile row text", () => {
    const r = parseAgentRead(out(...head, ...section("servers", [1, "x", null, [2], { id: 1 }]), CFY.done));
    expect(r.sections.get("servers")).toEqual([{ id: 1 }]);
  });

  it("bounds the image text", () => {
    const r = parseAgentRead(out("TUGRA_CFY_IMAGE " + "x".repeat(900), "TUGRA_CFY_RO on", `${CFYA.iso}repeatable read`, CFY.done));
    expect(r.image).toHaveLength(200);
  });
});
