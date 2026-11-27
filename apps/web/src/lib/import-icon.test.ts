import { describe, it, expect } from "vitest";
import { importItemIcon, importServiceIcon } from "./import-icon";
import type { ImportPlanItem } from "./types";

const item = (kind: ImportPlanItem["kind"], proposed: Record<string, unknown>): ImportPlanItem => ({ itemRef: "r", kind, name: "x", proposed, risks: [], dependsOn: [] });

describe("importItemIcon", () => {
  it("reads the image of an app row from the plan", () => {
    expect(importItemIcon(item("app", { image: "ghcr.io/n8n-io/n8n:latest", domain: "a.example.com" }))).toEqual({ image: "ghcr.io/n8n-io/n8n:latest", brand: null });
  });
  it("gives a database row its image and its engine logo", () => {
    expect(importItemIcon(item("database", { engine: "POSTGRES", image: "pgvector/pgvector:pg16" }))).toEqual({ image: "pgvector/pgvector:pg16", brand: { logo: "postgresql", slug: "POSTGRES" } });
    expect(importItemIcon(item("database", { engine: "MYSQL", image: null }))).toEqual({ image: null, brand: { logo: "mysql", slug: "MYSQL" } });
  });
  it("copes with a row that has neither", () => {
    expect(importItemIcon(item("app", { image: null }))).toEqual({ image: null, brand: null });
    expect(importItemIcon(item("app", {}))).toEqual({ image: null, brand: null });
  });
});

describe("importServiceIcon", () => {
  it("uses the stack name when it is a known brand, else the first member that is", () => {
    expect(importServiceIcon("n8n", [{ name: "postgres" }]).image).toBe("n8n");
    expect(importServiceIcon("my-stack", [{ name: "web" }, { name: "redis" }]).image).toBe("redis");
    expect(importServiceIcon("my-stack", [{ name: "web" }]).image).toBeNull();
  });
});
