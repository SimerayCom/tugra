import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { MoveAppCard } from "./move-app-card";
import { api } from "../lib/api";

vi.mock("./toast", () => ({ useToast: () => vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const base = { id: "a1", name: "blog", teamId: "t1", serverId: "s1", clusterId: null, move: null };
function show(over: Record<string, unknown> = {}) {
  vi.spyOn(api, "listServers").mockResolvedValue([]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MoveAppCard app={{ ...base, ...over } as never} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("MoveAppCard", () => {
  it("offers 'Move to server…' and opens the dialog", async () => {
    show();
    const btn = screen.getByRole("button", { name: "Move to server…" });
    expect(btn).toHaveProperty("disabled", false);
    fireEvent.click(btn);
    expect(await screen.findByRole("dialog", { name: "Move to another server" })).toBeTruthy();
  });

  it("is disabled WITH the reason while a move is live", () => {
    show({ move: { id: "mv1", phase: "TRANSFERRING" } });
    const btn = screen.getByRole("button", { name: "Move to server…" });
    expect(btn).toHaveProperty("disabled", true);
    expect(btn.getAttribute("title")).toMatch(/being moved to another server/);
    expect(screen.getByRole("note").textContent).toMatch(/paused until the move finishes/);
  });

  it("is disabled with the reason for a clustered (swarm) app", () => {
    show({ clusterId: "c1" });
    expect(screen.getByRole("button", { name: "Move to server…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("note").textContent).toMatch(/Swarm\/cluster apps can't be moved/);
  });
});
