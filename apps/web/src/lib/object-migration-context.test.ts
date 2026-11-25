import { describe, it, expect, beforeEach } from "vitest";
import { OBJECT_MIGRATION_CONTEXT_KEY, rememberObjectMigrationContext, takeObjectMigrationContext } from "./object-migration-context";

beforeEach(() => window.localStorage.clear());

describe("object migration context", () => {
  it("is read once", () => {
    rememberObjectMigrationContext({ targetServerId: "s1", serviceName: "minio", backHref: "/import/runs/r1" }, 1000);
    expect(takeObjectMigrationContext(2000)).toEqual({ targetServerId: "s1", serviceName: "minio", backHref: "/import/runs/r1" });
    expect(takeObjectMigrationContext(2000)).toBeNull();
  });
  it("expires after a few minutes", () => {
    rememberObjectMigrationContext({ targetServerId: "s1" }, 1000);
    expect(takeObjectMigrationContext(1000 + 16 * 60_000)).toBeNull();
  });
  it("drops a back link that leaves the site and anything malformed", () => {
    for (const bad of ["https://evil.example.com", "//evil.example.com", "javascript:alert(1)", "/a b"]) {
      rememberObjectMigrationContext({ targetServerId: "s1", backHref: bad }, 1000);
      expect(takeObjectMigrationContext(1000)).toEqual({ targetServerId: "s1" });
    }
    window.localStorage.setItem(OBJECT_MIGRATION_CONTEXT_KEY, "not json");
    expect(takeObjectMigrationContext()).toBeNull();
    rememberObjectMigrationContext({}, 1000);
    expect(takeObjectMigrationContext(1000)).toBeNull();
  });
});
