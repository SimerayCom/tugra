import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError } from "../lib/api";
import type { ChecklistRow, CoolifyChecklist, CoolifyInventoryView } from "../lib/coolify-takeover";
import { ConfirmProvider } from "./confirm";
import { CoolifyTakeover } from "./coolify-takeover";

const INV: CoolifyInventoryView = {
  serverId: "s1",
  serverName: "host-1",
  teamId: "t1",
  enabledAt: "2026-11-24T10:00:00Z",
  readAt: "2026-11-24T10:01:00Z",
  coolifyImage: "ghcr.io/coollabsio/coolify:4.0.0-beta.9",
  counts: { teams: 1, servers: 2, projects: 1, applications: 1, databases: 0, services: 0, sharedVariables: 0, scheduledTasks: 0, backups: 0, storages: 0 },
  data: {
    v: 1,
    instance: { name: "Acme Coolify", fqdn: "https://coolify.example.com", ip: null, image: "ghcr.io/coollabsio/coolify:4.0.0-beta.9" },
    teams: [{ id: "1", name: "Acme", description: null, personal: false, members: 2, notifications: [] }],
    servers: [
      { id: "0", uuid: "u0", name: "localhost", description: null, ip: "host.docker.internal", port: 22, user: "root", teamId: "1", isLocal: true, reachable: true, usable: true, buildServer: false, swarm: false, keyName: null, apps: 0, databases: 0, services: 0 },
      { id: "1", uuid: "u1", name: "edge", description: null, ip: "198.51.100.7", port: 22, user: "root", teamId: "1", isLocal: false, reachable: true, usable: true, buildServer: false, swarm: false, keyName: null, apps: 1, databases: 0, services: 0 },
    ],
    projects: [{ id: "1", uuid: "p1", name: "Website", description: null, teamId: "1", environments: [] }],
    applications: [
      { id: "7", uuid: "a", name: "web", fqdn: "https://www.example.com", gitRepository: null, gitBranch: null, buildPack: null, image: null, status: "running:healthy", envCount: 2, previewEnvCount: 0, hasCompose: false, teamId: "1", projectId: "1", environment: "production", serverId: "1" },
    ],
    databases: [],
    services: [],
    sharedVariables: [],
    scheduledTasks: [],
    backups: [],
    storages: [],
    gitSources: [],
    unavailable: [],
  },
};

const row = (over: Partial<ChecklistRow>): ChecklistRow => ({
  coolifyServerId: "1", name: "edge", ip: "198.51.100.7", port: 22, user: "root", state: "not_generated", teamId: "t1", tugraServerId: null, installCommand: null, expiresAt: null, ssh: "ssh root@198.51.100.7", ...over,
});
const CHECKLIST: CoolifyChecklist = { rows: [row({ coolifyServerId: "0", name: "localhost", state: "this_server", tugraServerId: "s1" }), row({})], teams: [{ id: "t1", name: "Acme" }] };

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(api, "listServers").mockResolvedValue([
    { id: "s1", name: "host-1", teamId: "t1", status: "ONLINE", canWrite: true, capabilities: ["database"] },
    { id: "s2", name: "edge-box", teamId: "t1", status: "ONLINE", canWrite: true, capabilities: ["database"] },
    { id: "s3", name: "down-box", teamId: "t1", status: "OFFLINE", canWrite: true, capabilities: ["database"] },
    { id: "s4", name: "plain-box", teamId: "t1", status: "ONLINE", canWrite: true, capabilities: ["deploy"] },
  ] as never);
});
afterEach(() => vi.restoreAllMocks());

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <I18nProvider>
        <ConfirmProvider>
          <CoolifyTakeover />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

async function pickServer() {
  show();
  const select = (await screen.findByLabelText("Server")) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: "s1" } });
}

describe("CoolifyTakeover", () => {
  it("asks for an explicit opt-in first, reads nothing, and only allows once Coolify was found", async () => {
    vi.spyOn(api, "coolifyInventory").mockRejectedValue(new ApiError(403, "not opted in", "not_enabled"));
    const detect = vi.spyOn(api, "coolifyDetect").mockResolvedValue({ found: true, image: "ghcr.io/coollabsio/coolify:4.0.0-beta.9" });
    const enable = vi.spyOn(api, "coolifyEnable").mockResolvedValue({ ...INV, data: null });
    const read = vi.spyOn(api, "coolifyRead").mockResolvedValue(INV);
    vi.spyOn(api, "coolifyServers").mockResolvedValue(CHECKLIST);
    await pickServer();

    await screen.findByText("Let Tugra read this Coolify");
    expect(read).not.toHaveBeenCalled();
    const allow = screen.getByRole("button", { name: "Allow and read" }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Check for Coolify" }));
    await screen.findByText("Coolify found (4.0.0-beta.9).");
    expect(detect).toHaveBeenCalledWith("s1");
    expect(enable).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Allow and read" }));
    await screen.findByText("Acme Coolify");
    expect(enable).toHaveBeenCalledWith("s1");
    expect(read).toHaveBeenCalledWith("s1");
  });

  it("explains when there is no Coolify on the server and keeps Allow disabled", async () => {
    vi.spyOn(api, "coolifyInventory").mockRejectedValue(new ApiError(403, "not opted in", "not_enabled"));
    vi.spyOn(api, "coolifyDetect").mockResolvedValue({ found: false, image: null });
    await pickServer();
    fireEvent.click(await screen.findByRole("button", { name: "Check for Coolify" }));
    await screen.findByText("No Coolify on this server. Pick the server that runs it.");
    expect((screen.getByRole("button", { name: "Allow and read" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists servers that cannot be read as disabled, with the reason in the label", async () => {
    show();
    const sel = (await screen.findByLabelText("Server")) as HTMLSelectElement;
    await waitFor(() => expect(sel.options.length).toBeGreaterThan(2));
    const opt = (name: string) => [...sel.options].find((o) => o.textContent?.startsWith(name))!;
    expect(opt("host-1").disabled).toBe(false);
    expect(opt("down-box").disabled).toBe(true);
    expect(opt("down-box").textContent).toBe("down-box (offline)");
    expect(opt("plain-box").disabled).toBe(true);
    expect(opt("plain-box").textContent).toBe("plain-box (capability off)");
  });

  it("an item opens the import on its server, already placed on the Tugra server it is connected as", async () => {
    vi.spyOn(api, "coolifyInventory").mockResolvedValue(INV);
    vi.spyOn(api, "coolifyServers").mockResolvedValue({ ...CHECKLIST, rows: [CHECKLIST.rows[0], row({ state: "already_added", tugraServerId: "s2", teamId: "t1" })] });
    await pickServer();
    await screen.findByText("Acme Coolify");
    await screen.findAllByText("Connected as edge-box");
    fireEvent.click(screen.getByRole("link", { name: "Open web in the import" }));
    expect(JSON.parse(window.sessionStorage.getItem("tugra.import.focus") ?? "{}")).toEqual({ kind: "coolify", address: "https://coolify.example.com", sourceServerUuid: "u1", targetServerId: "s2", targetTeamId: "t1" });
    expect(screen.getAllByText(/Open in import needs the Coolify API token/).length).toBeGreaterThan(0);
  });

  it("shows the inventory per team with a Move link per item into the existing import", async () => {
    vi.spyOn(api, "coolifyInventory").mockResolvedValue(INV);
    vi.spyOn(api, "coolifyServers").mockResolvedValue(CHECKLIST);
    await pickServer();
    await screen.findByText("Acme Coolify");
    expect(screen.getByText("Read-only copy")).toBeTruthy();
    const move = screen.getByRole("link", { name: "Open web in the import" }) as HTMLAnchorElement;
    expect(move.getAttribute("href")).toBe("/import");
    fireEvent.click(move);
    expect(window.sessionStorage.getItem("tugra.import.prefillUrl")).toBe("https://coolify.example.com");
  });

  it("lists the Coolify servers as a checklist: team per server, then copyable commands; nothing is run", async () => {
    vi.spyOn(api, "coolifyInventory").mockResolvedValue(INV);
    vi.spyOn(api, "coolifyServers").mockResolvedValue(CHECKLIST);
    const generate = vi.spyOn(api, "coolifyGenerateServers").mockResolvedValue({
      ...CHECKLIST,
      rows: [CHECKLIST.rows[0], row({ state: "waiting", tugraServerId: "new1", installCommand: "curl -fsSL https://hub.example.com/install/agent.sh | sh -s -- --token abc" })],
    });
    await pickServer();
    await screen.findByText("Add all Coolify servers");
    await screen.findByText("Agent here");
    fireEvent.click(await screen.findByRole("button", { name: "Get install commands (1)" }));
    await waitFor(() => expect(generate).toHaveBeenCalledWith("s1", [{ coolifyServerId: "1", teamId: "t1" }]));
    await screen.findByText(/install\/agent\.sh/);
    expect(screen.getByText("Waiting for its agent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy all commands" })).toBeTruthy();
  });

  it("can leave a server out of the batch", async () => {
    vi.spyOn(api, "coolifyInventory").mockResolvedValue(INV);
    vi.spyOn(api, "coolifyServers").mockResolvedValue(CHECKLIST);
    await pickServer();
    const box = (await screen.findByRole("checkbox", { name: "edge" })) as HTMLInputElement;
    fireEvent.click(box);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Get install commands/ })).toBeNull());
  });

  it("stopping asks first, then deletes the copy", async () => {
    vi.spyOn(api, "coolifyInventory").mockResolvedValue(INV);
    vi.spyOn(api, "coolifyServers").mockResolvedValue(CHECKLIST);
    const disable = vi.spyOn(api, "coolifyDisable").mockResolvedValue({ ok: true });
    await pickServer();
    fireEvent.click(await screen.findByRole("button", { name: "Stop and delete" }));
    await screen.findByText("Stop reading this Coolify?");
    expect(disable).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Stop and delete" }).at(-1)!);
    await waitFor(() => expect(disable).toHaveBeenCalledWith("s1"));
  });

  it("says why a non-admin cannot use it", async () => {
    vi.spyOn(api, "coolifyInventory").mockRejectedValue(new ApiError(403, "insufficient role for this team"));
    await pickServer();
    await screen.findByText("Only a team owner or admin can do this.");
  });
});
