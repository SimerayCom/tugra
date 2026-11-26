import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api, ApiError } from "../../lib/api";
import type { MatchRow } from "../../lib/coolify-agent";
import type { CoolifySshRunView, CoolifySshTargetView } from "../../lib/coolify-ssh";
import { ConfirmProvider } from "../confirm";
import { ToastProvider } from "../toast";
import { HostVerify } from "./host-verify";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const mk = (ref: string, name: string, over: Partial<MatchRow> = {}): MatchRow => ({
  ref, name, controlPlane: false, kind: "probable", status: "probable", tugraServerId: "t1", tugraName: "box", agentOnline: true, answeredByOwner: false, evidence: [], identityConflict: false, ...over,
});
const ROWS = [
  mk("hostuuid0001", "localhost", { controlPlane: true, kind: "certain", status: "certain" }),
  mk("edgeuuid0001", "edge"),
  mk("builduuid001", "builder"),
  mk("sureuuid0001", "sure", { kind: "certain", status: "certain" }),
];
const tv = (uuid: string, name: string, state: CoolifySshTargetView["state"], over: Partial<CoolifySshTargetView> = {}): CoolifySshTargetView => ({
  id: uuid, runId: "run1", coolifyServerUuid: uuid, name, state, code: null, tugraServerId: null, manualCommand: false, canRemove: false, probe: null, updatedAt: "2026-11-26T00:00:00Z", ...over,
});
const RUN = (targets: CoolifySshTargetView[], finished = false): CoolifySshRunView => ({ runId: "run1", inventoryServerId: "s0", teamId: "t1", expiresAt: "2026-11-26T02:00:00Z", finished, targets });
const consentRequired = () => new ApiError(409, "Confirm the check", "consent_required");

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
function mount(over: Partial<React.ComponentProps<typeof HostVerify>> = {}, withConfirm = true) {
  const onDone = vi.fn();
  const inner = <HostVerify serverId="s0" rows={ROWS} onDone={onDone} {...over} />;
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>{withConfirm ? <ConfirmProvider>{inner}</ConfirmProvider> : inner}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onDone };
}
const typeConfirm = (n: number) => fireEvent.change(screen.getByLabelText(`Type ${n} to confirm.`) as HTMLInputElement, { target: { value: String(n) } });

describe("HostVerify", () => {
  it("offers the check for the rows matched only by address, and says how many", () => {
    mount();
    expect(screen.getByText(/Matched only by address: 2\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check these machines automatically" })).toBeTruthy();
  });

  it("renders nothing when no row can gain from it, there is no Coolify host, or there is no confirm dialog to ask in", () => {
    mount({ rows: [ROWS[0], ROWS[3]] });
    expect(screen.queryByTestId("host-verify")).toBeNull();
    cleanup();
    mount({ serverId: null });
    expect(screen.queryByTestId("host-verify")).toBeNull();
    cleanup();
    mount({}, false);
    expect(screen.queryByTestId("host-verify")).toBeNull();
  });

  it("asks the hub, turns its consent_required into the in-place confirmation, and repeats the call with the typed number", async () => {
    const verify = vi
      .spyOn(api, "coolifySshVerify")
      .mockRejectedValueOnce(consentRequired())
      .mockResolvedValueOnce(RUN([tv("edgeuuid0001", "edge", "PROBING"), tv("builduuid001", "builder", "PROBING")]));
    vi.spyOn(api, "coolifySshRun").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "PROBING"), tv("builduuid001", "builder", "PROBING")]));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Check these machines automatically" }));
    await screen.findByText("Check 2 machines");
    expect(screen.getByText(/Nothing is installed or changed on the machines/)).toBeTruthy();
    const go = screen.getByRole("button", { name: "Check now" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true); // off until the number is typed
    typeConfirm(2);
    fireEvent.click(go);
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
    expect(verify).toHaveBeenNthCalledWith(1, "s0", { coolifyServerUuids: ["edgeuuid0001", "builduuid001"] });
    expect(verify).toHaveBeenNthCalledWith(2, "s0", { coolifyServerUuids: ["edgeuuid0001", "builduuid001"], confirm: "2" });
    await screen.findByText("Checked 0 of 2…");
  });

  it("does nothing more when the owner closes the confirmation", async () => {
    const verify = vi.spyOn(api, "coolifySshVerify").mockRejectedValue(consentRequired());
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Check these machines automatically" }));
    await screen.findByText("Check 2 machines");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Check 2 machines")).toBeNull());
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("shows progress while the probes run, then reads the match again once and shows what was checked", async () => {
    vi.spyOn(api, "coolifySshVerify").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "PROBING"), tv("builduuid001", "builder", "PLANNED")]));
    const poll = vi.spyOn(api, "coolifySshRun").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "VERIFIED"), tv("builduuid001", "builder", "PROBING")]));
    const { onDone } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Check these machines automatically" }));
    await screen.findByText("Checked 1 of 2…");
    expect(onDone).not.toHaveBeenCalled();
    poll.mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "VERIFIED"), tv("builduuid001", "builder", "VERIFIED")], true));
    await screen.findByText("Checked 2 of 2. Machines that proved to be the same now show as Same machine.", {}, { timeout: 6000 });
    expect(onDone).toHaveBeenCalledTimes(1);
  }, 10000);

  it("names the machines that could not be checked, in words, and keeps the button for another try", async () => {
    vi.spyOn(api, "coolifySshVerify").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "VERIFIED"), tv("builduuid001", "builder", "FAILED", { code: "auth_failed" })], true));
    vi.spyOn(api, "coolifySshRun").mockResolvedValue(RUN([tv("edgeuuid0001", "edge", "VERIFIED"), tv("builduuid001", "builder", "FAILED", { code: "auth_failed" })], true));
    const { onDone } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Check these machines automatically" }));
    await screen.findByText("Checked 1 of 2. Machines that proved to be the same now show as Same machine.");
    expect(screen.getByText("Could not be checked")).toBeTruthy();
    expect(screen.getByText("builder: The server did not accept Coolify's key.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check these machines automatically" })).toBeTruthy();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("tells a non-owner why, from the hub's refusal, and starts nothing", async () => {
    vi.spyOn(api, "coolifySshVerify").mockRejectedValue(new ApiError(403, "insufficient role for this team"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Check these machines automatically" }));
    await screen.findByText("Only a team owner can check machines this way.");
    expect(screen.queryByText(/Checked \d+ of/)).toBeNull();
  });

  it("turns the hub's stable codes into words", async () => {
    vi.spyOn(api, "coolifySshVerify").mockRejectedValue(new ApiError(409, "offline", "agent_offline"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Check these machines automatically" }));
    await screen.findByText("The agent on the Coolify server is offline.");
  });
});
