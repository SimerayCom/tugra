import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ToastProvider } from "../../../components/toast";
import { api } from "../../../lib/api";
import type { TelemetryStatus, PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { TelemetryCard } from "./telemetry-card";

const STATUS: TelemetryStatus = {
  enabled: true,
  forcedOff: false,
  dbEnabled: true,
  instanceId: "abcd1234-0000-0000-0000-000000000000",
  lastSentAt: null,
  intervalMin: 1440,
  endpoint: "https://telemetry.tugra.io/v1/ingest",
  payload: {
    instanceId: "abcd1234-0000-0000-0000-000000000000",
    version: "0.1.0",
    channel: "stable",
    edition: "community",
    platform: "linux",
    arch: "x64",
    nodeMajor: 22,
    counts: { servers: 2, applications: 5, databases: 1, deployments: 40, teams: 1, users: 1, clusters: 0, monitors: 3, containers: 6 },
    sentAt: "2026-10-25T00:00:00.000Z",
  },
};

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <TelemetryCard />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("TelemetryCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "getTelemetry").mockResolvedValue({ ...STATUS });
    vi.spyOn(api, "updateTelemetry").mockImplementation(async (enabled) => ({ ...STATUS, enabled, dbEnabled: enabled }));
    vi.spyOn(api, "sendTelemetryNow").mockResolvedValue({ status: "sent" });
    vi.spyOn(api, "resetTelemetryId").mockResolvedValue({ ...STATUS });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches", () => {
    wrap();
    expect(screen.queryByText("Anonymous usage stats")).toBeNull();
    expect(api.getTelemetry).not.toHaveBeenCalled();
  });

  it("shows the On badge + checked toggle for the owner", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    expect(await screen.findByText("Anonymous usage stats")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    expect(screen.getByText("On")).toBeTruthy();
  });

  it("opting out flips the toggle via PATCH", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Anonymous usage stats");
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(api.updateTelemetry).toHaveBeenCalledWith(false));
  });

  it("reveals the exact payload preview on demand (no hidden fields)", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Anonymous usage stats");
    fireEvent.click(screen.getByRole("button", { name: "See exactly what's sent" }));
    await waitFor(() => expect(screen.getByText(/"containers": 6/)).toBeTruthy());
  });

  it("send now calls the endpoint", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Anonymous usage stats");
    // The Send-now button is enabled only once the status loads (enabled: true) — wait for it.
    await waitFor(() => expect(screen.getByRole("button", { name: "Send now" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(api.sendTelemetryNow).toHaveBeenCalled());
  });

  it("shows the env-forced-off note and disables the toggle", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getTelemetry").mockResolvedValue({ ...STATUS, enabled: false, forcedOff: true });
    wrap();
    await screen.findByText("Anonymous usage stats");
    await waitFor(() => expect(screen.getByText(/turned off by the server environment/)).toBeTruthy());
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
});
