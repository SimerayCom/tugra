import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TeamBadge } from "./team-scope";

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
