import { describe, it, expect } from "vitest";
import { dbColor, defaultPort, engineLabel } from "./databases";

describe("database helpers", () => {
  it("maps db status to a color", () => {
    expect(dbColor("RUNNING")).toContain("--c-g");
    expect(dbColor("FAILED")).toContain("--c-r");
    expect(dbColor("STOPPED")).toContain("--c-am");
    expect(dbColor("NEW")).toContain("--c-tx3");
  });

  it("labels engines and gives their default ports", () => {
    expect(engineLabel("POSTGRES")).toBe("PostgreSQL");
    expect(engineLabel("MONGO")).toBe("MongoDB");
    expect(defaultPort("POSTGRES")).toBe(5432);
    expect(defaultPort("REDIS")).toBe(6379);
  });
});
