import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ToastProvider } from "./toast";
import { ServerTeamCard } from "./server-team-card";
import { api, ApiError } from "../lib/api";
import { blockerHref, blockersFromError, type TransferPlan } from "../lib/server-transfer";
import type { ServerView, Team } from "../lib/types";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: replaceMock, push: vi.fn() }) }));

afterEach(cleanup);
beforeEach(() => {
  vi.restoreAllMocks();
  replaceMock.mockReset();
});

const SERVER = { id: "s1", name: "app-1", teamId: "tA" } as unknown as ServerView;
const TEAMS = [
  { id: "tA", name: "Acme", role: "OWNER" },
  { id: "tB", name: "Beta", role: "ADMIN" },
] as unknown as Team[];

const plan = (over: Partial<TransferPlan> = {}): TransferPlan => ({
  server: { id: "s1", name: "app-1" },
  from: { id: "tA", name: "Acme" },
  to: { id: "tB", name: "Beta" },
  blockers: [],
  detaches: [],
  canMove: true,
  ...over,
});

function mount(opts: { targets?: { id: string; name: string }[]; teams?: Team[] } = {}) {
  vi.spyOn(api, "listTeams").mockResolvedValue(opts.teams ?? TEAMS);
  vi.spyOn(api, "getServerTeamTargets").mockResolvedValue(opts.targets ?? [{ id: "tB", name: "Beta" }]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <ServerTeamCard id="s1" server={SERVER} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function openDialog() {
  const select = (await screen.findByLabelText("Move to team")) as HTMLSelectElement;
  await waitFor(() => expect(screen.getByRole("option", { name: "Beta" })).toBeTruthy());
  fireEvent.change(select, { target: { value: "tB" } });
  fireEvent.click(screen.getByRole("button", { name: "Change team" }));
}

describe("ServerTeamCard", () => {
  it("shows the current team by name and keeps the action off until a team is chosen", async () => {
    mount();
    expect(await screen.findByText("Acme")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Change team" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so when there is no other team to move to", async () => {
    mount({ targets: [] });
    expect(await screen.findByText("You have no other team to move this server to.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change team" })).toBeNull();
  });

  it("previews, then moves on confirm and closes the dialog", async () => {
    mount();
    const preview = vi.spyOn(api, "previewServerTeamChange").mockResolvedValue(plan({ detaches: [{ kind: "cloud_credential", name: "Provider key" }] }));
    const change = vi.spyOn(api, "changeServerTeam").mockResolvedValue({ ok: true, serverId: "s1", fromTeamId: "tA", toTeamId: "tB" });
    await openDialog();
    expect(await screen.findByText("Move app-1 to Beta?")).toBeTruthy();
    expect(preview).toHaveBeenCalledWith("s1", "tB");
    expect(change).not.toHaveBeenCalled(); // nothing moves before confirm
    // Details sit behind "More".
    const more = screen.getByText("More");
    expect(more.closest("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByText(/Provider key/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move server" }));
    await waitFor(() => expect(change).toHaveBeenCalledWith("s1", "tB"));
    await waitFor(() => expect(screen.queryByText("Move app-1 to Beta?")).toBeNull());
    expect(replaceMock).not.toHaveBeenCalled(); // still a member of the new team: stay on the page
  });

  it("lists blocking resources as links and disables the move", async () => {
    mount();
    vi.spyOn(api, "previewServerTeamChange").mockResolvedValue(
      plan({
        canMove: false,
        blockers: [
          { kind: "application", count: 12, items: [{ id: "a1", name: "web" }] },
          { kind: "database", count: 1, items: [{ id: "d1", name: "pg" }] },
        ],
      }),
    );
    const change = vi.spyOn(api, "changeServerTeam");
    await openDialog();
    expect(await screen.findByText(/still has resources that belong to Acme/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "web" }).getAttribute("href")).toBe("/apps/a1");
    expect(screen.getByRole("link", { name: "pg" }).getAttribute("href")).toBe("/databases/d1");
    expect(screen.getByText("and 11 more")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Move server" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(change).not.toHaveBeenCalled();
  });

  it("shows the new blockers when a resource appeared between preview and confirm", async () => {
    mount();
    vi.spyOn(api, "previewServerTeamChange").mockResolvedValue(plan());
    vi.spyOn(api, "changeServerTeam").mockRejectedValue(
      new ApiError(409, "blocked", "server_transfer_blocked", {
        code: "server_transfer_blocked",
        blockers: [{ kind: "database", count: 1, items: [{ id: "d9", name: "late-db" }] }],
      }),
    );
    await openDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Move server" }));
    expect(await screen.findByText("late-db")).toBeTruthy();
    expect(screen.getByText("Something new appeared on this server. Move or remove it first.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Move server" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a refused preview instead of offering the move", async () => {
    mount();
    vi.spyOn(api, "previewServerTeamChange").mockRejectedValue(new ApiError(403, "insufficient permission for this team"));
    await openDialog();
    expect(await screen.findByText("insufficient permission for this team")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Move server" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves the page when the new team is not one the user belongs to", async () => {
    mount({ teams: [TEAMS[0]] });
    vi.spyOn(api, "previewServerTeamChange").mockResolvedValue(plan());
    vi.spyOn(api, "changeServerTeam").mockResolvedValue({ ok: true, serverId: "s1", fromTeamId: "tA", toTeamId: "tB" });
    await openDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Move server" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/servers"));
  });
});

describe("server transfer helpers", () => {
  it("links each blocking resource to its page", () => {
    expect(blockerHref("application", "a")).toBe("/apps/a");
    expect(blockerHref("build_server", "a")).toBe("/apps/a");
    expect(blockerHref("database", "d")).toBe("/databases/d");
    expect(blockerHref("cluster", "c")).toBe("/clusters/c");
    expect(blockerHref("monitor", "m")).toBe("/monitors");
    expect(blockerHref("reboot", "r")).toBeNull();
  });

  it("reads blockers only from a server_transfer_blocked body", () => {
    const blockers = [{ kind: "database", count: 1, items: [] }];
    expect(blockersFromError({ code: "server_transfer_blocked", blockers })).toEqual(blockers);
    expect(blockersFromError({ code: "other", blockers })).toBeNull();
    expect(blockersFromError(undefined)).toBeNull();
  });
});
