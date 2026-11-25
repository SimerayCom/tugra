import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError } from "../lib/api";
import type { CoolifySshRunView, CoolifySshTargetView } from "../lib/coolify-ssh";
import type { ChecklistRow } from "../lib/coolify-takeover";
import { ConfirmProvider } from "./confirm";
import { ToastProvider } from "./toast";
import { CoolifySshInstall } from "./coolify-ssh-install";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const row = (over: Partial<ChecklistRow>): ChecklistRow => ({
  coolifyServerId: "1", coolifyServerUuid: "edgeuuid0001", name: "edge", ip: "198.51.100.7", port: 22, user: "root", state: "not_generated", teamId: "t1", tugraServerId: null, installCommand: null, expiresAt: null, ssh: "ssh root@198.51.100.7", ...over,
});
const ROWS = [
  row({ coolifyServerId: "0", coolifyServerUuid: "hostuuid0001", name: "localhost", state: "this_server" }),
  row({}),
  row({ coolifyServerId: "2", coolifyServerUuid: "builduuid001", name: "builder", ip: "198.51.100.8" }),
  row({ coolifyServerId: "3", coolifyServerUuid: "doneuuid0001", name: "already", state: "already_added", tugraServerId: "x" }),
];
const TEAMS = [{ id: "t1", name: "Acme" }];

const tv = (uuid: string, name: string, state: CoolifySshTargetView["state"], over: Partial<CoolifySshTargetView> = {}): CoolifySshTargetView => ({
  id: uuid, runId: "run1", coolifyServerUuid: uuid, name, state, code: null, tugraServerId: null, manualCommand: false, canRemove: false, probe: null, updatedAt: "2026-11-26T00:00:00Z", ...over,
});
const RUN = (targets: CoolifySshTargetView[], finished = false): CoolifySshRunView => ({ runId: "run1", inventoryServerId: "s1", teamId: "t1", expiresAt: "2026-11-26T02:00:00Z", finished, targets });

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
const mount = (owner = true) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <CoolifySshInstall serverId="s1" rows={ROWS} teams={TEAMS} ownerOfInventory={owner} />
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const typeConfirm = (n: number) => {
  const input = screen.getByLabelText(`Type ${n} to confirm.`) as HTMLInputElement;
  fireEvent.change(input, { target: { value: String(n) } });
};

describe("CoolifySshInstall", () => {
  it("offers only the servers that have no agent, with their address, and explains what happens", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(null);
    mount();
    await screen.findByText("Install the Tugra agent");
    expect(screen.getByRole("checkbox", { name: /edge \(198\.51\.100\.7\)/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /builder/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /localhost/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /already/ })).toBeNull();
    fireEvent.click(screen.getByText("What happens"));
    expect(screen.getByText(/The keys stay on the Coolify server/)).toBeTruthy();
    expect(screen.getByText(/left alone/)).toBeTruthy();
  });

  it("asks for the typed number of servers before it checks: the button stays off until the number is right", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(null);
    const start = vi.spyOn(api, "coolifySshStart").mockResolvedValue(RUN([]));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Install on 2 servers" }));
    await screen.findByText("Checking first. Nothing is changed yet.");
    expect((screen.getByRole("button", { name: "Check 2 servers" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type 2 to confirm.") as HTMLInputElement, { target: { value: "1" } });
    expect((screen.getByRole("button", { name: "Check 2 servers" }) as HTMLButtonElement).disabled).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it("starts the probe once the right number is typed", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(null);
    const start = vi.spyOn(api, "coolifySshStart").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "PROBING"), tv("builduuid001", "builder", "PROBING")]));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Install on 2 servers" }));
    typeConfirm(2);
    fireEvent.click(screen.getByRole("button", { name: "Check 2 servers" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("s1", { coolifyServerUuids: ["edgeuuid0001", "builduuid001"], teamId: "t1", confirm: "2" }));
  });

  it("can leave a server out of the run", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(null);
    const start = vi.spyOn(api, "coolifySshStart").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "PROBING")]));
    mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: /builder/ }));
    fireEvent.click(screen.getByRole("button", { name: "Install on 1 server" }));
    typeConfirm(1);
    fireEvent.click(screen.getByRole("button", { name: "Check 1 servers" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("s1", expect.objectContaining({ coolifyServerUuids: ["edgeuuid0001"], confirm: "1" })));
  });

  it("shows the probe result per server in words, and installs the ready ones after the typed count", async () => {
    const ready = RUN([
      tv("edgeuuid0001", "edge", "READY"),
      tv("builduuid001", "builder", "FAILED", { code: "needs_root", manualCommand: true }),
      tv("x1", "old", "SKIPPED_PRESENT", { code: "skipped_present" }),
    ]);
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(ready);
    const install = vi.spyOn(api, "coolifySshInstall").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "INSTALLING")]));
    mount();
    await screen.findByText("Check finished: 1 ready, 1 left alone, 1 cannot be installed.");
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Needs root or passwordless sudo. Use the manual command.")).toBeTruthy();
    expect(screen.getByText("Use the install command for this server in the list above.")).toBeTruthy();
    expect(screen.getByText("A Tugra agent is already here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install on 1 ready" }));
    typeConfirm(1);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("s1", "run1", { confirm: "1" }));
  });

  it("polls while an install is going and shows progress, then the result", async () => {
    const latest = vi.spyOn(api, "coolifySshLatest").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "WAIT_ENROLL")]));
    mount();
    await screen.findByText("Waiting for the agent");
    expect(screen.getByText("Working…")).toBeTruthy();
    latest.mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "ONLINE", { canRemove: true, tugraServerId: "new1" })], true));
    await waitFor(() => expect(screen.getByText("Online")).toBeTruthy(), { timeout: 6000 });
    expect(screen.getByText("Done: 1 online.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove 1 agents" })).toBeTruthy();
  }, 10000);

  it("undo asks for the typed count and removes the agents this run installed", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "ONLINE", { canRemove: true, tugraServerId: "n1" })], true));
    const un = vi.spyOn(api, "coolifySshUninstall").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "UNINSTALLING")]));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove 1 agents" }));
    typeConfirm(1);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(un).toHaveBeenCalledWith("s1", "run1", { confirm: "1" }));
  });

  it("cancels a run that is working", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "PROBING")]));
    const cancel = vi.spyOn(api, "coolifySshCancel").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "FAILED", { code: "cancelled" })], true));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("s1", "run1"));
  });

  it("is for owners: anyone else sees why, and every action button is off", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "READY")]));
    mount(false);
    await screen.findByText(/Only a team owner can install agents this way/);
    expect(((await screen.findByRole("button", { name: "Install on 1 ready" })) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says a failure in words from the hub's code, never the raw message", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(null);
    vi.spyOn(api, "coolifySshStart").mockRejectedValue(new ApiError(409, "internal detail 10.0.0.1", "agent_offline"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Install on 2 servers" }));
    typeConfirm(2);
    fireEvent.click(screen.getByRole("button", { name: "Check 2 servers" }));
    await screen.findByText("The agent on the Coolify server is offline.");
    expect(screen.queryByText(/10\.0\.0\.1/)).toBeNull();
  });

  it("renders nothing when every server already has an agent and there is no run", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(null);
    const { container } = render(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <ToastProvider>
            <ConfirmProvider>
              <CoolifySshInstall serverId="s1" rows={[ROWS[0], ROWS[3]]} teams={TEAMS} ownerOfInventory />
            </ConfirmProvider>
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("never shows a token, a key or a command line", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "ONLINE", { canRemove: true, tugraServerId: "n1" })], true));
    const { container } = mount();
    await screen.findByText("Online");
    expect(container.textContent).not.toMatch(/tugra_en_|BEGIN|--token|curl /);
    expect(within(container).queryByText(/ssh_key/)).toBeNull();
  });
});

describe("CoolifySshInstall (owner gate on the start button)", () => {
  it("a non-owner cannot start a check either", async () => {
    vi.spyOn(api, "coolifySshLatest").mockResolvedValue(null);
    mount(false);
    expect(((await screen.findByRole("button", { name: "Install on 2 servers" })) as HTMLButtonElement).disabled).toBe(true);
  });
});
