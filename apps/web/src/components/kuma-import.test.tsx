import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError } from "../lib/api";
import type { KumaApplyResult, KumaPlan } from "../lib/types";
import { KumaImport } from "./kuma-import";

const PLAN: KumaPlan = {
  monitors: [
    { ref: "1", name: "Website", kumaType: "http", type: "HTTP", target: "https://example.com", action: "create", warnings: [{ code: "retry_interval", params: { seconds: 20 } }], channelRefs: ["10"] },
    { ref: "2", name: "Postgres", kumaType: "port", type: "TCP", target: "db.example.com:5432", action: "create", warnings: [], channelRefs: [] },
    { ref: "3", name: "Old site", kumaType: "http", type: "HTTP", target: "https://old.example.com", action: "exists", warnings: [], channelRefs: [] },
    { ref: "4", name: "Container", kumaType: "docker", type: null, target: null, action: "unsupported", reason: "type", warnings: [], channelRefs: [] },
  ],
  channels: [
    { ref: "10", name: "Ops chat", kumaType: "telegram", type: "telegram", action: "create", warnings: [], usedBy: 1 },
    { ref: "11", name: "Unused hook", kumaType: "webhook", type: "webhook", action: "create", warnings: [{ code: "webhook_format" }], usedBy: 0 },
    { ref: "12", name: "Pager", kumaType: "pagerduty", type: null, action: "unsupported", reason: "type", warnings: [], usedBy: 0 },
  ],
  totals: { monitors: 4, create: 2, exists: 1, unsupported: 1, channelsToCreate: 2 },
};

const RESULT: KumaApplyResult = {
  channels: [{ ref: "10", name: "Ops chat", status: "created", id: "c1" }],
  monitors: [
    { ref: "1", name: "Website", status: "created", id: "m1" },
    { ref: "2", name: "Postgres", status: "failed", error: "boom" },
  ],
  totals: { monitorsCreated: 1, monitorsFailed: 1, channelsCreated: 1, channelsFailed: 0 },
};

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme" }] as never);
  vi.spyOn(api, "listServers").mockResolvedValue([{ id: "s1", name: "app-1", teamId: "t1" }] as never);
});
afterEach(() => vi.restoreAllMocks());

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <I18nProvider>
        <KumaImport />
      </I18nProvider>
    </QueryClientProvider>,
  );

async function uploadAndPreview() {
  show();
  const input = (await screen.findByLabelText("Backup file")) as HTMLInputElement;
  const file = new File(['{"monitorList":[]}'], "kuma-backup.json", { type: "application/json" });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText("kuma-backup.json is ready.");
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
}

describe("KumaImport — backup file", () => {
  it("previews first: nothing is applied until the user imports", async () => {
    const preview = vi.spyOn(api, "kumaPreview").mockResolvedValue(PLAN);
    const apply = vi.spyOn(api, "kumaApply").mockResolvedValue(RESULT);
    await uploadAndPreview();
    expect(await screen.findByText("2 to import, 1 already here, 1 can't be imported.")).toBeTruthy();
    expect(preview).toHaveBeenCalledWith({ teamId: "t1", source: { kind: "backup", json: '{"monitorList":[]}' } });
    expect(apply).not.toHaveBeenCalled();
  });

  it("ticks new monitors and only the alerts they use; alerts that can't be created have no checkbox", async () => {
    vi.spyOn(api, "kumaPreview").mockResolvedValue(PLAN);
    await uploadAndPreview();
    await screen.findByText("Website");
    expect((screen.getByRole("checkbox", { name: "Website" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Ops chat/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Unused hook/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("checkbox", { name: /Pager/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Old site" })).toBeNull();
    expect(screen.getByRole("button", { name: "Import 2" })).toBeTruthy();
  });

  it("applies exactly the selection, then reports the result and what failed", async () => {
    vi.spyOn(api, "kumaPreview").mockResolvedValue(PLAN);
    const apply = vi.spyOn(api, "kumaApply").mockResolvedValue(RESULT);
    await uploadAndPreview();
    await screen.findByText("Website");
    fireEvent.click(screen.getByRole("checkbox", { name: "Postgres" })); // untick
    fireEvent.click(screen.getByRole("checkbox", { name: /Unused hook/ })); // opt in to an extra alert
    fireEvent.click(screen.getByRole("button", { name: "Import 1" }));
    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply).toHaveBeenCalledWith({
      teamId: "t1",
      source: { kind: "backup", json: '{"monitorList":[]}' },
      monitorRefs: ["1"],
      createChannelRefs: ["10", "11"],
    });
    expect(await screen.findByText("Imported 1 monitors and 1 alerts.")).toBeTruthy();
    expect(screen.getByText(/1 could not be imported\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: /View uptime/ }).getAttribute("href")).toBe("/monitors");
  });

  it("explains a bad file with the hub's error code", async () => {
    vi.spyOn(api, "kumaPreview").mockRejectedValue(new ApiError(400, "x", "not_kuma"));
    await uploadAndPreview();
    expect(await screen.findByText("This isn't Uptime Kuma data.")).toBeTruthy();
  });

  it("keeps the preview button disabled until a file is chosen", async () => {
    show();
    await screen.findByLabelText("Backup file");
    expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("KumaImport — read from a server", () => {
  it("finds Kuma, then previews from that container", async () => {
    vi.spyOn(api, "kumaDetect").mockResolvedValue({ containers: [{ container: "uptime-kuma", image: "louislam/uptime-kuma:1", state: "running", hasData: true }] });
    const preview = vi.spyOn(api, "kumaPreview").mockResolvedValue(PLAN);
    show();
    fireEvent.click(await screen.findByLabelText(/A server/));
    const select = (await screen.findByLabelText("Server")) as HTMLSelectElement;
    await waitFor(() => expect(screen.getByRole("option", { name: "app-1" })).toBeTruthy());
    fireEvent.change(select, { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Find Kuma" }));
    await waitFor(() => expect(api.kumaDetect).toHaveBeenCalledWith({ teamId: "t1", serverId: "s1" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith({ teamId: "t1", source: { kind: "server", serverId: "s1", container: "uptime-kuma" } }));
  });

  it("says so when the server has no Kuma", async () => {
    vi.spyOn(api, "kumaDetect").mockResolvedValue({ containers: [] });
    show();
    fireEvent.click(await screen.findByLabelText(/A server/));
    await waitFor(() => expect(screen.getByRole("option", { name: "app-1" })).toBeTruthy());
    fireEvent.change(await screen.findByLabelText("Server"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Find Kuma" }));
    expect(await screen.findByText("No Uptime Kuma found on this server.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
