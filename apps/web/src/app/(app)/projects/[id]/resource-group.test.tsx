import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Box } from "lucide-react";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ResourceGroup } from "./resource-group";
import type { ProjectResource } from "../../../../lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
afterEach(cleanup);

const res = (over: Partial<ProjectResource>): ProjectResource => ({
  id: "r1", name: "thing", kind: "app", source: "IMAGE", status: "RUNNING", url: null, serverName: null, tags: [], engine: null,
  iconUpdatedAt: null, templateSlug: null, templateLogo: null, iconKey: null, image: null, domain: null, ...over,
});
const show = (items: ProjectResource[]) =>
  render(
    <I18nProvider>
      <ResourceGroup title="Things" items={items} icon={Box} />
    </I18nProvider>,
  );
const srcOf = (container: HTMLElement, href: string) => (container.querySelector(`a[href="${href}"]`) as HTMLElement).querySelector("img")?.getAttribute("src") ?? null;

describe("ResourceGroup icons", () => {
  it("shows the site favicon for an app with a domain, from the hub", () => {
    const { container } = show([res({ id: "a1", name: "shop", source: "GIT", domain: "shop.example.com" })]);
    expect(srcOf(container, "/apps/a1")).toBe("/api/v1/apps/a1/favicon?v=shop.example.com");
  });

  it("shows the brand of the image for an image app without a domain", () => {
    const { container } = show([res({ id: "a2", name: "cache", image: "ghcr.io/valkey-io/valkey:8" })]);
    expect(srcOf(container, "/apps/a2")).toBe("/icons/valkey.svg");
  });

  it("shows a picked icon over everything else, and an uploaded one over a picked one", () => {
    const { container } = show([
      res({ id: "a3", name: "x", iconKey: "ghost", domain: "x.example.com", image: "redis:7" }),
      res({ id: "a4", name: "y", iconKey: "ghost", iconUpdatedAt: "2026-12-10T00:00:00Z" }),
    ]);
    expect(srcOf(container, "/apps/a3")).toBe("/icons/ghost.svg");
    expect(srcOf(container, "/apps/a4")).toContain("/api/v1/apps/a4/icon?v=");
  });

  it("shows the engine logo for a database, the image's brand when it names a different one, and an upload", () => {
    const { container } = show([
      res({ id: "d1", name: "pg", kind: "database", source: null, engine: "POSTGRES", image: "postgres:16" }),
      res({ id: "d2", name: "kv", kind: "database", source: null, engine: "REDIS", image: "valkey/valkey:8" }),
      res({ id: "d3", name: "m", kind: "database", source: null, engine: "MYSQL", image: "mysql:8", iconUpdatedAt: "2026-12-10T00:00:00Z" }),
      res({ id: "d4", name: "o", kind: "database", source: null, engine: "LIBSQL", image: "ghcr.io/acme/libsql" }),
    ]);
    expect(srcOf(container, "/databases/d1")).toBe("/icons/postgresql.svg");
    expect(srcOf(container, "/databases/d2")).toBe("/icons/valkey.svg");
    expect(srcOf(container, "/databases/d3")).toBe("/api/v1/databases/d3/icon?v=2026-12-10T00%3A00%3A00Z");
    expect(srcOf(container, "/databases/d4")).toBe("/icons/sqlite.svg");
  });

  it("keeps every icon at a fixed size so the rows do not shift", () => {
    const { container } = show([res({ id: "a1", name: "shop", domain: "shop.example.com" }), res({ id: "d1", name: "pg", kind: "database", source: null, engine: "POSTGRES" })]);
    for (const img of Array.from(container.querySelectorAll("img"))) {
      expect(img.getAttribute("width")).toBe("22");
      expect(img.getAttribute("height")).toBe("22");
      expect(img.getAttribute("loading")).toBe("lazy");
    }
  });

  it("renders nothing for an empty group", () => {
    const { container } = show([]);
    expect(container.innerHTML).toBe("");
  });
});
