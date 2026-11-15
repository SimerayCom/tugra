import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VX_409 } from "./vx-constants";

const HUB = join(__dirname, "../../../test/fixtures/vx-409-literals.json");
const GO = join(__dirname, "../../../../../agent/internal/migrate/testdata/vx-409-literals.json");

interface Vectors {
  vectors: Array<{ message: string; kind: string }>;
}

describe("vx 409 literal vectors (shared with the Go classify409 test)", () => {
  it("the hub and the Go copies are byte-identical", () => {
    expect(readFileSync(GO, "utf8")).toBe(readFileSync(HUB, "utf8"));
  });

  it("every literal the hub can throw is present exactly once with a kind", () => {
    const v = (JSON.parse(readFileSync(HUB, "utf8")) as Vectors).vectors;
    const messages = v.map((x) => x.message);
    for (const lit of Object.values(VX_409)) expect(messages.filter((m) => m === lit)).toHaveLength(1);
    expect(new Set(messages).size).toBe(messages.length);
    expect(v.every((x) => /^[A-Za-z]+$/.test(x.kind))).toBe(true);
    // an unknown literal must stay UnknownConflict (fail closed)
    expect(v.find((x) => x.message === "something nobody has ever thrown")!.kind).toBe("UnknownConflict");
  });
});
