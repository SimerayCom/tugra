import { looksOpaque, nameFromLabels, sameLabels, sanitizeContainerMeta, type ContainerLabelRow } from "./container-labels";

const row = (o: Partial<ContainerLabelRow> = {}): ContainerLabelRow => ({ name: "", resource: "", project: "", environment: "", service: "", ...o });

describe("looksOpaque", () => {
  it("flags uuids and long generated ids, with or without a timestamp suffix", () => {
    expect(looksOpaque("0b8f4a4e-5d1c-4f6e-9a7b-2c3d4e5f6a7b")).toBe(true);
    expect(looksOpaque("kgr3jx23x9ck5w2h8n7p4q1z")).toBe(true);
    expect(looksOpaque("kgr3jx23x9ck5w2h8n7p4q1z-123456789012")).toBe(true);
    expect(looksOpaque("")).toBe(true);
  });
  it("keeps human names readable", () => {
    expect(looksOpaque("blog")).toBe(false);
    expect(looksOpaque("api-production")).toBe(false);
    expect(looksOpaque("postgresql-database-server")).toBe(false);
    expect(looksOpaque("Acme Storefront")).toBe(false);
  });
});

describe("sanitizeContainerMeta", () => {
  it("keeps only the five known fields, trimmed and capped, mapping env→environment", () => {
    const out = sanitizeContainerMeta({ name: "  n ", resource: "r", project: "p".repeat(500), env: "production", service: "web", extra: "x" } as never);
    expect(out).toEqual({ name: "n", resource: "r", project: "p".repeat(120), environment: "production", service: "web" });
  });
  it("strips control characters and ignores non-strings", () => {
    expect(sanitizeContainerMeta({ resource: "a\u0000b\nc", project: 5 } as never)).toMatchObject({ resource: "a b c", project: "" });
  });
  it("returns null when nothing usable was sent", () => {
    expect(sanitizeContainerMeta(undefined)).toBeNull();
    expect(sanitizeContainerMeta({} as never)).toBeNull();
    expect(sanitizeContainerMeta({ name: "  ", service: 3 } as never)).toBeNull();
  });
});

describe("nameFromLabels", () => {
  it("prefers the resource name and adds the project/environment/service", () => {
    expect(nameFromLabels(row({ resource: "Blog", name: "kgr3jx23x9ck5w2h8n7p4q1z-123456", project: "Acme Site", environment: "production", service: "php" }))).toEqual({
      label: "Blog · php", project: "Acme Site", environment: "production", service: "php",
    });
  });
  it("skips an opaque coolify.name and falls back to the compose service", () => {
    expect(nameFromLabels(row({ name: "kgr3jx23x9ck5w2h8n7p4q1z-123456", service: "worker" }))).toEqual({ label: "worker", service: "worker" });
  });
  it("uses a readable coolify.name when there is no resource name", () => {
    expect(nameFromLabels(row({ name: "my-api" }))).toEqual({ label: "my-api" });
  });
  it("does not repeat the service when it equals the app name", () => {
    expect(nameFromLabels(row({ resource: "Redis", service: "redis" }))).toMatchObject({ label: "Redis" });
  });
  it("returns null when no label is readable (caller keeps the container name)", () => {
    expect(nameFromLabels(row({ name: "0b8f4a4e-5d1c-4f6e-9a7b-2c3d4e5f6a7b", project: "Acme" }))).toBeNull();
    expect(nameFromLabels(row())).toBeNull();
  });
});

describe("sameLabels", () => {
  it("compares every field", () => {
    expect(sameLabels(row({ project: "a" }), row({ project: "a" }))).toBe(true);
    expect(sameLabels(row({ project: "a" }), row({ project: "b" }))).toBe(false);
    expect(sameLabels(row({ service: "a" }), row())).toBe(false);
  });
});
