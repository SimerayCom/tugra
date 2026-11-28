import { describe, it, expect } from "vitest";
import { githubOwnerOf, hostOfDomain, planAppIcon, planIconUrl } from "./plan-app-icon";

describe("githubOwnerOf", () => {
  it("reads the owner from every shape of a GitHub repository address", () => {
    for (const u of ["https://github.com/acme/site", "https://github.com/acme/site.git", "git@github.com:acme/site.git", "ssh://git@github.com/acme/site.git", "https://token@github.com/acme/site"]) expect(githubOwnerOf(u)).toBe("acme");
  });
  it("knows nothing about any other host, or about something that is not a repository address", () => {
    for (const u of ["https://gitlab.com/acme/site", "https://github.com.evil.test/acme/site", "https://github.com/acme", "", null, undefined, 5, "https://github.com/-bad/site"]) expect(githubOwnerOf(u)).toBeNull();
  });
});

describe("planAppIcon", () => {
  it("takes the image, the catalog slug, the primary host and the repository owner out of the plan item", () => {
    expect(planAppIcon({ proposed: { image: "postgres:16", templateSlug: null, domain: "https://App.Example.com/x", git: { url: "git@github.com:acme/site.git" } } })).toEqual({ image: "postgres:16", templateSlug: null, domain: "app.example.com", githubOwner: "acme" });
  });
  it("an item with none of it is all empty, never an error", () => {
    expect(planAppIcon({ proposed: {} })).toEqual({ image: null, templateSlug: null, domain: null, githubOwner: null });
    expect(hostOfDomain("app.example.com:8080")).toBe("app.example.com");
  });
  it("asks the hub for the icon, same origin", () => {
    expect(planIconUrl("github", "acme")).toBe("/api/v1/migration-campaigns/icon?kind=github&name=acme");
    expect(planIconUrl("site", "a b.com")).toContain("name=a%20b.com");
  });
});
