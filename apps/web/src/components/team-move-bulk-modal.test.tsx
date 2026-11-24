import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { TeamMoveBulkModal } from "./team-move-bulk-modal";
import { api } from "../lib/api";
import type { ServerView } from "../lib/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const servers = [
  { id: "s1", name: "app-1", teamId: "t1", canWrite: true },
  { id: "s2", name: "app-2", teamId: "t2", canWrite: true },
  { id: "s3", name: "app-3", teamId: "t1", canWrite: false },
] as unknown as ServerView[];

const open = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <TeamMoveBulkModal servers={servers} selectedIds={["s1", "s2", "s3"]} onClose={() => {}} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("TeamMoveBulkModal", () => {
  it("sends only writable servers that are not already in the target team, then shows each outcome", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme" }, { id: "t2", name: "Beta" }] as never);
    const spy = vi.spyOn(api, "changeServersTeam").mockResolvedValue({
      moved: 0,
      results: [{ serverId: "s1", status: "blocked", blockers: [{ kind: "application", count: 2, items: [] }] }],
    });
    open();
    expect(screen.getByRole("button", { name: /Move 0 servers/ })).toBeDisabled();
    await screen.findByRole("option", { name: "Beta" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "t2" } });
    expect(screen.getAllByTestId("team-move-row").map((r) => r.textContent)).toEqual(["app-1Will move", "app-2Already in this team", "app-3No permission"]);
    fireEvent.click(screen.getByRole("button", { name: /Move 1 servers/ }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(["s1"], "t2"));
    expect(await screen.findByText("Moved 0 of 1.")).toBeTruthy();
    expect(screen.getByText("Stays: has 2 apps")).toBeTruthy();
  });
});
