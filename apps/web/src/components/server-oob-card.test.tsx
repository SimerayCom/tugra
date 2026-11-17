import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ServerOobCard } from "./server-oob-card";
import { api, ApiError } from "../lib/api";
import type { OobCandidate, OobStatus } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
const card = () => <ServerOobCard id="s1" serverName="web-1" />;

const status = (over: Partial<OobStatus> = {}): OobStatus => ({
  linked: true,
  provider: "hetzner",
  providerServerId: "42",
  manual: false,
  supported: true,
  credentialName: "prod",
  credentialMissing: false,
  canManage: true,
  canOps: true,
  state: { providerServerId: "42", name: "web-1-cloud", status: "running", locked: false, rescueEnabled: false, publicIpv4: "203.0.113.10", publicIpv6: null },
  stateError: null,
  ...over,
});
const stub = (s: OobStatus) => vi.spyOn(api, "getServerOob").mockResolvedValue(s);
const action = { ok: true as const, action: "x", providerAction: { id: "1", status: "running" as const, command: "c" } };

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => vi.restoreAllMocks());

describe("visibility", () => {
  it("shows nothing for a server with no cloud link when the viewer cannot manage it", async () => {
    stub(status({ linked: false, state: null, canManage: false, canOps: false }));
    const { container } = wrap(card());
    await waitFor(() => expect(api.getServerOob).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("offers the link (and only the link) to a writer when there is no cloud link", async () => {
    stub(status({ linked: false, provider: null, providerServerId: null, state: null }));
    wrap(card());
    expect(await screen.findByRole("button", { name: /Link to Hetzner/ })).toBeTruthy();
    expect(screen.queryByTestId("oob-actions")).toBeNull();
  });

  it("a linked server shows the power state and every action", async () => {
    stub(status());
    wrap(card());
    const state = await screen.findByTestId("oob-state");
    expect(state.textContent).toContain("Power: Running");
    for (const name of ["Power on", "Shut down", "Hard reboot", "Power off", "Enable rescue", "Open console"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("a member without the operator role sees the status but no action buttons", async () => {
    stub(status({ canOps: false }));
    wrap(card());
    await screen.findByTestId("oob-state");
    expect(screen.queryByTestId("oob-actions")).toBeNull();
    expect(screen.getByText(/operator role/)).toBeTruthy();
  });

  it("armed rescue shows its badge and offers Disable instead of Enable; a provider read error is shown without hiding the link", async () => {
    stub(status({ state: { providerServerId: "42", name: "w", status: "off", locked: false, rescueEnabled: true, publicIpv4: null, publicIpv6: null } }));
    wrap(card());
    await screen.findByText("Rescue armed");
    expect(screen.getByRole("button", { name: "Disable rescue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enable rescue" })).toBeNull();
    cleanup();
    stub(status({ state: null, stateError: "hetzner is rate limiting requests; try again later" }));
    wrap(card());
    expect((await screen.findByRole("note")).textContent).toContain("rate limiting");
  });
});

describe("power actions", () => {
  it("Power on needs no confirmation", async () => {
    stub(status());
    const send = vi.spyOn(api, "oobPower").mockResolvedValue(action);
    wrap(card());
    fireEvent.click(await screen.findByRole("button", { name: "Power on" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("s1", { action: "power_on" }));
  });

  it.each([
    ["Shut down", "shutdown", "Shut down web-1?"],
    ["Hard reboot", "reboot", "Hard reboot web-1?"],
    ["Power off", "power_off", "Power off web-1?"],
  ])("%s asks for the server's name; nothing is sent until it is typed exactly", async (label, wire, title) => {
    stub(status());
    const send = vi.spyOn(api, "oobPower").mockResolvedValue(action);
    wrap(card());
    fireEvent.click(await screen.findByRole("button", { name: label }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText(title)).toBeTruthy();
    const confirm = within(dlg).getAllByRole("button").find((b) => b.className.includes("tg-btn") && b.textContent === label) as HTMLButtonElement;
    const field = within(dlg).getByLabelText(/Type the server name \(web-1\)/) as HTMLInputElement;
    expect(confirm.disabled).toBe(true);
    for (const wrong of ["web", "WEB-1", "web-1 ", "web-1-cloud"]) {
      fireEvent.change(field, { target: { value: wrong } });
      expect(confirm.disabled, wrong).toBe(true);
    }
    fireEvent.click(confirm);
    expect(send).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "web-1" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(send).toHaveBeenCalledWith("s1", { action: wire, confirmName: "web-1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a hub refusal is shown in the dialog (the provider's clear error) and the dialog stays open", async () => {
    stub(status());
    vi.spyOn(api, "oobPower").mockRejectedValue(new ApiError(409, "another action is already running on this server at hetzner; wait a moment and try again", "oob_locked"));
    wrap(card());
    fireEvent.click(await screen.findByRole("button", { name: "Hard reboot" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText(/Type the server name/), { target: { value: "web-1" } });
    fireEvent.click(within(dlg).getAllByRole("button").find((b) => b.textContent === "Hard reboot")!);
    expect((await within(dlg).findByRole("alert")).textContent).toContain("already running");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("one-time secrets", () => {
  it("enable rescue: confirm first, then the root password is shown once and gone when the dialog closes", async () => {
    stub(status());
    const send = vi.spyOn(api, "oobEnableRescue").mockResolvedValue({ ...action, rootPassword: "RESCUE-PW-123", expiresInMinutes: 60 });
    wrap(card());
    fireEvent.click(await screen.findByRole("button", { name: "Enable rescue" }));
    const ask = await screen.findByRole("dialog");
    expect(send).not.toHaveBeenCalled(); // a plain confirmation comes first
    fireEvent.click(within(ask).getByRole("button", { name: "Enable rescue" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByTestId("oob-secret").textContent).toBe("RESCUE-PW-123");
    expect(within(dlg).getByText(/Tugra does not store it/)).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "I have copied it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain("RESCUE-PW-123");
    // never kept in the query cache either
    expect(JSON.stringify(qc.getMutationCache().getAll().map((m) => m.state.data))).not.toContain("RESCUE-PW-123");
    expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain("RESCUE-PW-123");
  });

  it("console: shows the websocket address and VNC password once, with the one-minute validity", async () => {
    stub(status());
    vi.spyOn(api, "oobConsole").mockResolvedValue({ ...action, wssUrl: "wss://console.example/?token=abc", password: "VNC-PW-9", validForSeconds: 60 });
    wrap(card());
    fireEvent.click(await screen.findByRole("button", { name: "Open console" }));
    const ask = await screen.findByRole("dialog");
    fireEvent.click(within(ask).getByRole("button", { name: "Request console" }));
    const dlg = await screen.findByText("Console session").then(() => screen.getByRole("dialog"));
    const secrets = within(dlg).getAllByTestId("oob-secret").map((e) => e.textContent);
    expect(secrets).toEqual(["wss://console.example/?token=abc", "VNC-PW-9"]);
    expect(within(dlg).getByText(/Address valid for \d+ s/)).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "I have copied it" }));
    await waitFor(() => expect(document.body.textContent).not.toContain("VNC-PW-9"));
  });

  it("a failed rescue request shows the error and no secret", async () => {
    stub(status());
    vi.spyOn(api, "oobEnableRescue").mockRejectedValue(new ApiError(424, "hetzner rejected the stored API token", "oob_credential_rejected"));
    wrap(card());
    fireEvent.click(await screen.findByRole("button", { name: "Enable rescue" }));
    const ask = await screen.findByRole("dialog");
    fireEvent.click(within(ask).getByRole("button", { name: "Enable rescue" }));
    expect((await within(ask).findByRole("alert")).textContent).toContain("rejected the stored API token");
    expect(screen.queryByTestId("oob-secret")).toBeNull();
  });
});

describe("linking an existing server", () => {
  const cand = (over: Partial<OobCandidate>): OobCandidate => ({ providerServerId: "42", name: "web-1-cloud", status: "running", locked: false, rescueEnabled: false, publicIpv4: "203.0.113.10", publicIpv6: null, matchesIp: true, taken: false, ...over });
  function open() {
    stub(status({ linked: false, provider: null, providerServerId: null, state: null }));
    vi.spyOn(api, "listCloudCredentials").mockResolvedValue([
      { id: "cc1", name: "prod", teamId: "t1", provider: "hetzner", createdAt: "", canWrite: true },
      { id: "cc2", name: "other team", teamId: "t2", provider: "hetzner", createdAt: "", canWrite: true },
      { id: "cc3", name: "do", teamId: "t1", provider: "digitalocean", createdAt: "", canWrite: true },
    ]);
    vi.spyOn(api, "getServer").mockResolvedValue({ id: "s1", teamId: "t1" } as never);
  }

  it("lists this team's Hetzner credentials only, then the cloud servers; an IP match links straight away", async () => {
    open();
    vi.spyOn(api, "oobCandidates").mockResolvedValue([cand({}), cand({ providerServerId: "77", name: "db", matchesIp: false }), cand({ providerServerId: "88", name: "taken-vm", taken: true, matchesIp: false })]);
    const link = vi.spyOn(api, "oobLink").mockResolvedValue(status());
    wrap(card());
    fireEvent.click(await screen.findByRole("button", { name: /Link to Hetzner/ }));
    const dlg = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dlg).getAllByRole("radio")).toHaveLength(3));
    expect(within(dlg).getAllByRole("option").map((o) => o.textContent)).toEqual(["prod"]);
    expect(within(dlg).getByText("Same public IP")).toBeTruthy();
    expect((within(dlg).getAllByRole("radio")[2] as HTMLInputElement).disabled).toBe(true); // already linked elsewhere
    const confirm = within(dlg).getByRole("button", { name: "Link" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dlg).getAllByRole("radio")[0]);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(link).toHaveBeenCalledWith("s1", { cloudCredentialId: "cc1", providerServerId: "42" }));
  });

  it("a cloud server whose IP does not match needs its name typed before Link is enabled", async () => {
    open();
    vi.spyOn(api, "oobCandidates").mockResolvedValue([cand({ providerServerId: "77", name: "db", matchesIp: false })]);
    const link = vi.spyOn(api, "oobLink").mockResolvedValue(status());
    wrap(card());
    fireEvent.click(await screen.findByRole("button", { name: /Link to Hetzner/ }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(await within(dlg).findByRole("radio"));
    expect(within(dlg).getByText(/We cannot prove this is the same machine/)).toBeTruthy();
    const confirm = within(dlg).getByRole("button", { name: "Link" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText(/type the cloud server's name \(db\)/), { target: { value: "db" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(link).toHaveBeenCalledWith("s1", { cloudCredentialId: "cc1", providerServerId: "77", confirmProviderName: "db" }));
  });

  it("no Hetzner credential in the team: says so, nothing to pick", async () => {
    stub(status({ linked: false, provider: null, providerServerId: null, state: null }));
    vi.spyOn(api, "listCloudCredentials").mockResolvedValue([]);
    vi.spyOn(api, "getServer").mockResolvedValue({ id: "s1", teamId: "t1" } as never);
    wrap(card());
    fireEvent.click(await screen.findByRole("button", { name: /Link to Hetzner/ }));
    expect(await screen.findByText(/No Hetzner credential in this team yet/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Link" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
