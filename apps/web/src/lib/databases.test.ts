import { describe, it, expect } from "vitest";
import { dbColor, isDbTransitional, defaultPort, engineLabel, engineSupportsBackup } from "./databases";

describe("database helpers", () => {
  it("maps db status to a color", () => {
    expect(dbColor("RUNNING")).toContain("--c-g");
    expect(dbColor("FAILED")).toContain("--c-r");
    expect(dbColor("STOPPED")).toContain("--c-am");
    expect(dbColor("NEW")).toContain("--c-am");
    expect(dbColor("PROVISIONING")).toContain("--c-am");
    expect(dbColor("STARTING")).toContain("--c-am");
    expect(dbColor("SOMETHING_ELSE")).toContain("--c-tx3");
    expect(isDbTransitional("NEW")).toBe(true);
    expect(isDbTransitional("RUNNING")).toBe(false);
  });

  it("labels engines and gives their default ports", () => {
    expect(engineLabel("POSTGRES")).toBe("PostgreSQL");
    expect(engineLabel("MONGO")).toBe("MongoDB");
    expect(engineLabel("MARIADB")).toBe("MariaDB");
    expect(engineLabel("CLICKHOUSE")).toBe("ClickHouse");
    expect(defaultPort("POSTGRES")).toBe(5432);
    expect(defaultPort("REDIS")).toBe(6379);
    expect(defaultPort("CLICKHOUSE")).toBe(9000);
  });

  it("every engine now supports backup (incl. Dragonfly + ClickHouse) — except libSQL", () => {
    expect(engineSupportsBackup("MARIADB")).toBe(true);
    expect(engineSupportsBackup("KEYDB")).toBe(true);
    expect(engineSupportsBackup("DRAGONFLY")).toBe(true);
    expect(engineSupportsBackup("CLICKHOUSE")).toBe(true);
    expect(engineSupportsBackup("LIBSQL")).toBe(false);
  });

  it("maps libSQL's label + HTTP port", () => {
    expect(engineLabel("LIBSQL")).toBe("libSQL");
    expect(defaultPort("LIBSQL")).toBe(8080);
  });
});
