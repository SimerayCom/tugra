import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ConfirmProvider } from "../../../components/confirm";
import { api } from "../../../lib/api";
import NotificationsPage from "./page";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("NotificationsPage — event list from the backend single source", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team", role: "OWNER" }] as never);
    vi.spyOn(api, "listChannels").mockResolvedValue([] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders the events fetched from /channels/events (incl. backup_failed) and omits monitor events", async () => {
    vi.spyOn(api, "listChannelEvents").mockResolvedValue({ events: ["deploy_failed", "server_offline", "backup_failed"] });
    wrap(<NotificationsPage />);
    // "Backup failed" is the real i18n label — it only appears if the checkbox came from the fetched list.
    await waitFor(() => expect(screen.getByText("Backup failed")).toBeTruthy());
    expect(screen.getByText("Deploy failed")).toBeTruthy();
    // deploy_success was NOT in the fetched list → its checkbox is absent, proving the list is
    // fetch-driven (the old hardcoded array always included it). Orphan monitor events aren't offered.
    expect(screen.queryByText("Deploy success")).toBeNull();
  });

  it("renders the newly-added operation events with their i18n labels", async () => {
    vi.spyOn(api, "listChannelEvents").mockResolvedValue({
      events: ["backup_success", "server_online", "swarm_degraded", "volume_backup_failed", "scheduled_task_success", "docker_cleanup_success"],
    });
    wrap(<NotificationsPage />);
    await waitFor(() => expect(screen.getByText("Backup succeeded")).toBeTruthy());
    expect(screen.getByText("Server back online")).toBeTruthy();
    expect(screen.getByText("Swarm degraded")).toBeTruthy();
    expect(screen.getByText("Volume backup failed")).toBeTruthy();
    expect(screen.getByText("Scheduled task succeeded")).toBeTruthy();
    expect(screen.getByText("Docker cleanup succeeded")).toBeTruthy();
  });

  it("gracefully renders an unknown event id (raw-key fallback) without crashing", async () => {
    vi.spyOn(api, "listChannelEvents").mockResolvedValue({ events: ["backup_failed", "brand_new_event"] });
    wrap(<NotificationsPage />);
    await waitFor(() => expect(screen.getByText("Backup failed")).toBeTruthy());
    // an id with no EVENT_LABEL / i18n key falls back to the raw key rather than throwing
    expect(screen.getByText("notifications.brand_new_event")).toBeTruthy();
  });

  it("renders a newly-added provider's config fields when its type is selected (resend)", async () => {
    vi.spyOn(api, "listChannelEvents").mockResolvedValue({ events: ["deploy_failed"] });
    const { container } = wrap(<NotificationsPage />);
    await waitFor(() => expect(screen.getByText("Deploy failed")).toBeTruthy());
    // the channel-type select shows the default option "SMTP"; switch it to the new "resend" type
    fireEvent.change(screen.getByDisplayValue("SMTP"), { target: { value: "resend" } });
    expect(screen.getByText("API key")).toBeTruthy(); // f_apiKey label rendered
    expect(screen.getByText("From address")).toBeTruthy(); // reused f_from
    expect(container.querySelector('input[type="password"]')).toBeTruthy(); // apiKey is a secret field
  });
});

describe("NotificationsPage — rich provider config fields", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team", role: "OWNER" }] as never);
    vi.spyOn(api, "listChannels").mockResolvedValue([] as never);
    vi.spyOn(api, "listChannelEvents").mockResolvedValue({ events: ["deploy_failed"] });
  });
  afterEach(() => vi.restoreAllMocks());

  const switchType = async (value: string) => {
    const res = wrap(<NotificationsPage />);
    await waitFor(() => expect(screen.getByText("Deploy failed")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("SMTP"), { target: { value } });
    return res;
  };

  it("webhook: surfaces the signing secret (masked) + a custom-headers editor", async () => {
    const { container } = await switchType("webhook");
    expect(screen.getByText("Webhook URL")).toBeTruthy();
    expect(screen.getByText("Signing secret (HMAC)")).toBeTruthy();
    expect(screen.getByText("Add header")).toBeTruthy();
    expect(container.querySelector('input[type="password"]')).toBeTruthy(); // signingSecret masked
  });

  it("pushover: surfaces priority/retry/expire as number fields", async () => {
    const { container } = await switchType("pushover");
    expect(screen.getByText("Priority")).toBeTruthy();
    expect(screen.getByText("Retry (seconds)")).toBeTruthy();
    expect(screen.getByText("Expire (seconds)")).toBeTruthy();
    expect(container.querySelector('input[type="number"]')).toBeTruthy();
  });

  it("ntfy: surfaces priority + access token (masked)", async () => {
    const { container } = await switchType("ntfy");
    expect(screen.getByText("Priority")).toBeTruthy();
    expect(screen.getByText("Access token")).toBeTruthy();
    expect(container.querySelector('input[type="password"]')).toBeTruthy(); // accessToken masked
  });

  it("telegram: surfaces the message thread id", async () => {
    await switchType("telegram");
    expect(screen.getByText("Message thread ID")).toBeTruthy();
  });

  it("resets the SMTP TLS toggle when the channel type is switched away and back", async () => {
    wrap(<NotificationsPage />);
    await waitFor(() => expect(screen.getByText("Deploy failed")).toBeTruthy());
    const secureBox = () => screen.getByLabelText("Use TLS (secure)") as HTMLInputElement;
    fireEvent.click(secureBox());
    expect(secureBox().checked).toBe(true);
    fireEvent.change(screen.getByDisplayValue("SMTP"), { target: { value: "discord" } });
    fireEvent.change(screen.getByDisplayValue("DISCORD"), { target: { value: "smtp" } });
    expect(secureBox().checked).toBe(false); // stale TLS flag must not survive a type round-trip
  });

  it("folds webhook custom-header rows into a config.headers object on submit", async () => {
    const createSpy = vi.spyOn(api, "createChannel").mockResolvedValue({} as never);
    await switchType("webhook");
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "hook" } });
    fireEvent.click(screen.getByText("Add header"));
    fireEvent.change(screen.getByPlaceholderText("Header"), { target: { value: "X-Api-Key" } });
    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "abc123" } });
    fireEvent.click(screen.getByText("Add channel"));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "webhook", config: expect.objectContaining({ headers: { "X-Api-Key": "abc123" } }) }),
    );
  });
});
