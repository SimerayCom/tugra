import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
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
function show(over: Record<string, unknown> = {}, client = new QueryClient()) {
  vi.spyOn(api, "listServers").mockResolvedValue([]);
  render(
    <QueryClientProvider client={client}>
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

  it("starting a move refreshes the app and move queries at once (the page lock and the banner do not wait for the next poll)", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.spyOn(api, "previewAppMove").mockResolvedValue({
      ok: true, blockers: [], warnings: [], requiredAcks: [],
      plan: { cheap: true, volumes: [], totalBytes: 0, partBytes: 0, estimatedParts: 0, sourceStagingFreeBytes: null, targetFreeBytes: null, estimatedDowntimeSec: { low: 0, high: 0 }, domain: { kind: "none", from: null, to: null }, hostPort: { from: null, to: null }, targetIp: null, link: null },
    } as never);
    vi.spyOn(api, "startAppMove").mockResolvedValue({ moveId: "mv1", phase: "QUEUED" });
    show({}, client);
    vi.spyOn(api, "listServers").mockResolvedValue([
      { id: "s1", name: "alpha", status: "ONLINE", teamId: "t1" },
      { id: "s2", name: "beta", status: "ONLINE", teamId: "t1" },
    ] as never);
    fireEvent.click(screen.getByRole("button", { name: "Move to server…" }));
    const select = (await screen.findByLabelText("Target server")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: "s2" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("What will happen");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText("Type the app name to confirm"), { target: { value: "blog" } });
    fireEvent.click(screen.getByRole("button", { name: "Move app" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["app", "a1"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["app-moves", "a1"] });
  });
});
