import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TeamBadge, TeamDot } from "./team-scope";
import { ProjectDot } from "./project-dot";
import { api } from "../lib/api";
import { vi } from "vitest";

const wrap = (node: ReactNode) => <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;

afterEach(cleanup);

describe("TeamBadge", () => {
  it("renders the team name tinted with the team's colour", () => {
    render(wrap(<TeamBadge teamId="t1" teams={[{ id: "t1", name: "Acme", color: "#8e4ec6" }]} />));
    const el = screen.getByText("Acme").closest(".ent") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.getPropertyValue("--ent-solid-l")).toBe("#8e4ec6");
  });

  it("keeps the neutral pill for an uncoloured team and renders nothing for an unknown one", () => {
    const { container, rerender } = render(wrap(<TeamBadge teamId="t1" teams={[{ id: "t1", name: "Acme" }]} />));
    expect(container.querySelector(".ent")).toBeNull();
    expect(screen.getByText("Acme")).toBeTruthy();
    rerender(wrap(<TeamBadge teamId="nope" teams={[{ id: "t1", name: "Acme" }]} />));
    expect(container.firstChild).toBeNull();
  });
});

describe("TeamDot / ProjectDot", () => {
  afterEach(() => vi.restoreAllMocks());

  it("TeamDot shows the team colour once the teams load and is titled with the team name", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER", color: "#8e4ec6" }] as never);
    const { container } = render(wrap(<TeamDot teamId="t1" />));
    await screen.findByTitle("Acme");
    expect((container.querySelector(".ent") as HTMLElement).style.getPropertyValue("--ent-solid-l")).toBe("#8e4ec6");
  });

  it("TeamDot renders nothing for an uncoloured team", async () => {
    const spy = vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER" }] as never);
    const { container } = render(wrap(<TeamDot teamId="t1" />));
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.querySelector(".ent")).toBeNull();
  });

  it("ProjectDot shows the project colour and skips the fetch without a project", async () => {
    const spy = vi.spyOn(api, "listProjects").mockResolvedValue([{ id: "p1", name: "Shop", color: "#12a594" }] as never);
    const none = render(wrap(<ProjectDot projectId={null} />));
    expect(none.container.firstChild).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    cleanup();
    const { container } = render(wrap(<ProjectDot projectId="p1" />));
    await vi.waitFor(() => expect(container.querySelector(".ent")).not.toBeNull());
  });
});
