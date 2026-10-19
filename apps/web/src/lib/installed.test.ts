import { describe, it, expect } from "vitest";
import { installedBySlug } from "./installed";
import type { Application } from "./types";

const app = (over: Partial<Application>): Application =>
  ({ id: "x", name: "x", templateSlug: null, url: null, status: "RUNNING", source: "IMAGE", ...over } as Application);

describe("installedBySlug", () => {
  it("returns an empty map when nothing is installed from a template", () => {
    const m = installedBySlug([app({ id: "a", templateSlug: null })]);
    expect(m.size).toBe(0);
  });

  it("indexes a single running install with its open URL", () => {
    const m = installedBySlug([app({ id: "g1", templateSlug: "ghost", status: "RUNNING", url: "https://g.example.com" })]);
    expect(m.get("ghost")).toEqual({ count: 1, running: true, firstId: "g1", url: "https://g.example.com" });
  });

  it("does not offer an Open URL for a stopped install", () => {
    const m = installedBySlug([app({ id: "g1", templateSlug: "ghost", status: "STOPPED", url: "https://g.example.com" })]);
    expect(m.get("ghost")).toMatchObject({ count: 1, running: false, url: null });
  });

  it("counts multiple installs and prefers a running install's URL for Open", () => {
    const m = installedBySlug([
      app({ id: "g1", templateSlug: "ghost", status: "STOPPED", url: "https://stopped.example.com" }),
      app({ id: "g2", templateSlug: "ghost", status: "RUNNING", url: "https://running.example.com" }),
    ]);
    expect(m.get("ghost")).toEqual({ count: 2, running: true, firstId: "g1", url: "https://running.example.com" });
  });

  it("keeps separate entries per template slug", () => {
    const m = installedBySlug([
      app({ id: "a", templateSlug: "ghost", status: "RUNNING", url: null }),
      app({ id: "b", templateSlug: "n8n", status: "FAILED", url: null }),
    ]);
    expect(m.size).toBe(2);
    expect(m.get("ghost")).toMatchObject({ running: true });
    expect(m.get("n8n")).toMatchObject({ running: false, count: 1 });
  });
});
