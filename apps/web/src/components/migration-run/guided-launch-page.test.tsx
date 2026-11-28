import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { ToastProvider } from "../toast";
import { api, ApiError } from "../../lib/api";
import { GuidedLaunchPage } from "./guided-launch-page";
import { saveLaunchHandoff } from "../../lib/launch-handoff";
import type { ImportPlan } from "../../lib/types";
import type { ImportScope } from "../../lib/import-scope";

let search = "s=session-abc12345";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(search) }));

const item = (itemRef: string, kind: "app" | "database", name: string) => ({ itemRef, kind, name, proposed: {}, risks: [], dependsOn: [] });
const plan = { sourceKind: "coolify", mode: "copy", planHash: "a".repeat(32), warnings: [], totals: { apps: 1, databases: 0, volumes: 0, blockers: 0 }, items: [item("app:s1:web", "app", "web")], preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts: [{ ref: "s1", name: "Alpha" }] } } as unknown as ImportPlan;
const scope: ImportScope = {
  selection: { mode: "everything", hosts: new Set(), projects: new Set(), extra: new Set(), placement: { s1: "srv1" } },
  inScope: new Set(["app:s1:web"]),
  narrowed: false,
  defaultServerId: "srv1",
  serverMap: undefined,
  placed: { s1: "srv1" },
  placementKind: { s1: "in-place" },
};
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <ToastProvider>
          <GuidedLaunchPage />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  search = "s=session-abc12345";
  window.sessionStorage.clear();
  vi.spyOn(api, "listServers").mockResolvedValue([{ id: "srv1", name: "Server A", teamId: "t1", canWrite: true }] as never);
  vi.spyOn(api, "listTeams").mockResolvedValue([] as never);
  vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ acmeEmail: "ops@example.com" } as never);
  vi.spyOn(api, "listMigrationRuns").mockResolvedValue([]);
  vi.spyOn(api, "planCampaign").mockResolvedValue({ planHash: plan.planHash, views: [], runs: [{ sourceServerRef: "s1", kind: "in-place", targetServerId: "srv1", topology: "swap-proxy", wave: 0 }], failure: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the guided launch page", () => {
  it("says there is nothing to start when the choices from the review are gone, and links back", async () => {
    mount();
    expect((await screen.findByTestId("launch-gone")).textContent).toContain("Go back to the review");
    expect(screen.getByRole("link", { name: "Back to the review" }).getAttribute("href")).toBe("/import");
  });

  it("keeps the page across a reload: the handoff in the session and the id in the address bring the same launch back", async () => {
    saveLaunchHandoff({ kind: "coolify", sessionId: "session-abc12345", planHash: plan.planHash, extras: {}, scope });
    const read = vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    mount();
    expect(await screen.findByRole("button", { name: "Start the takeover" })).toBeTruthy();
    expect(read).toHaveBeenCalledWith({ sourceKind: "coolify", sessionId: "session-abc12345" });
    expect(screen.getByText("Take over your servers in place")).toBeTruthy();
  });

  it("ignores a handoff of another session", async () => {
    saveLaunchHandoff({ kind: "coolify", sessionId: "session-other9999", planHash: plan.planHash, extras: {}, scope });
    const read = vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    mount();
    await screen.findByTestId("launch-gone");
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses to start on a source that changed since the review", async () => {
    saveLaunchHandoff({ kind: "coolify", sessionId: "session-abc12345", planHash: plan.planHash, extras: {}, scope });
    vi.spyOn(api, "importPlan").mockResolvedValue({ ...plan, planHash: "b".repeat(32) });
    mount();
    expect((await screen.findByTestId("launch-changed")).textContent).toContain("Coolify changed");
    expect(screen.queryByRole("button", { name: "Start the takeover" })).toBeNull();
  });

  it("says when the connection ended, and when the plan could not be read", async () => {
    saveLaunchHandoff({ kind: "coolify", sessionId: "session-abc12345", planHash: plan.planHash, extras: {}, scope });
    const read = vi.spyOn(api, "importPlan").mockRejectedValue(new ApiError(404, "gone"));
    mount();
    expect((await screen.findByTestId("launch-read-failed")).textContent).toContain("connection to Coolify ended");
    cleanup();
    read.mockRejectedValue(new Error("down"));
    mount();
    await waitFor(() => expect(screen.getByTestId("launch-read-failed").textContent).toContain("could not be read"));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
