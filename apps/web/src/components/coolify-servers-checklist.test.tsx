import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError } from "../lib/api";
import type { ChecklistRow, CoolifyChecklist } from "../lib/coolify-takeover";
import { probableChecklistRows } from "../lib/host-verify";
import { ConfirmProvider } from "./confirm";
import { ToastProvider } from "./toast";
import { CoolifyServersChecklist } from "./coolify-servers-checklist";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const row = (over: Partial<ChecklistRow>): ChecklistRow => ({
  coolifyServerId: "1", coolifyServerUuid: "edgeuuid0001", name: "edge", ip: "198.51.100.7", port: 22, user: "root", state: "already_added", teamId: "t1", tugraServerId: "x", installCommand: null, expiresAt: null, ssh: "ssh root@198.51.100.7", ...over,
});
const DATA: CoolifyChecklist = {
  teams: [{ id: "t1", name: "Acme" }],
  rows: [
    row({ coolifyServerId: "0", coolifyServerUuid: "hostuuid0001", name: "localhost", state: "this_server" }),
    row({ probable: true }),
    row({ coolifyServerId: "2", coolifyServerUuid: "sureuuid0001", name: "settled" }),
  ],
};

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
function mount() {
  vi.spyOn(api, "coolifyServers").mockResolvedValue(DATA);
  vi.spyOn(api, "coolifyInventory").mockResolvedValue({ teamId: "t1" } as never);
}
function mountOwner(role: string) {
  vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role }] as never);
  vi.spyOn(api, "coolifySshLatest").mockResolvedValue(null);
  mount();
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <CoolifyServersChecklist serverId="s0" />
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("probableChecklistRows", () => {
  it("takes only the already-added rows the hub marked probable", () => {
    const rows = probableChecklistRows(DATA.rows);
    expect(rows.map((r) => r.ref)).toEqual(["edgeuuid0001"]);
    expect(rows[0]).toMatchObject({ kind: "probable", status: "probable", controlPlane: false, answeredByOwner: false });
    expect(probableChecklistRows([row({ state: "not_generated", probable: true })])).toEqual([]);
  });
});

describe("CoolifyServersChecklist host check", () => {
  it("offers the identity check for a server already in Tugra that is only probably the same, to the owner", async () => {
    mountOwner("OWNER");
    await screen.findByText(/Matched only by address: 1\./);
    expect(screen.getByRole("button", { name: "Check these machines automatically" })).toBeTruthy();
  });

  it("asks the hub through the verify route with the Coolify server uuid, then reads the list again", async () => {
    const verify = vi.spyOn(api, "coolifySshVerify").mockRejectedValueOnce(new ApiError(409, "Confirm", "consent_required")).mockResolvedValueOnce({ runId: "r1", inventoryServerId: "s0", teamId: "t1", expiresAt: "2026-11-26T02:00:00Z", finished: false, targets: [] });
    mountOwner("OWNER");
    fireEvent.click(await screen.findByRole("button", { name: "Check these machines automatically" }));
    fireEvent.change(await screen.findByLabelText("Type 1 to confirm."), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(verify).toHaveBeenLastCalledWith("s0", { coolifyServerUuids: ["edgeuuid0001"], confirm: "1" }));
    expect(verify).toHaveBeenNthCalledWith(1, "s0", { coolifyServerUuids: ["edgeuuid0001"] });
  });

  it("shows nothing of it to a non-owner", async () => {
    mountOwner("ADMIN");
    await screen.findByText("edge");
    expect(screen.queryByTestId("host-verify")).toBeNull();
  });
});
