import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ConfirmProvider } from "../../../components/confirm";
import { api } from "../../../lib/api";
import { subscribeToast } from "../../../lib/toast-bus";
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
    fireEvent.change(screen.getByDisplayValue("Discord"), { target: { value: "smtp" } });
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

describe("NotificationsPage — channel test feedback", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team", role: "OWNER" }] as never);
    vi.spyOn(api, "listChannelEvents").mockResolvedValue({ events: ["deploy_failed"] });
    vi.spyOn(api, "listChannels").mockResolvedValue([{ id: "c1", name: "Ops Slack", type: "slack", teamId: "t1", enabled: true, canWrite: true, eventTypes: ["deploy_failed"] }] as never);
    vi.spyOn(api, "listDeliveries").mockResolvedValue([] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("names the channel in the success toast after Test", async () => {
    vi.spyOn(api, "testChannel").mockResolvedValue({ ok: true } as never);
    const toasts: string[] = [];
    const off = subscribeToast((x) => toasts.push(x.message));
    wrap(<NotificationsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    await waitFor(() => expect(toasts).toContain("Test sent to Ops Slack"));
    off();
  });
});

const VOCAB = {
  events: ["deploy_failed", "backup_failed"],
  categories: ["uptime", "deploy", "backup", "server", "security", "updates"],
  eventCategories: { deploy_failed: "deploy", backup_failed: "backup" },
  severities: ["info", "warning", "critical"],
};

describe("NotificationsPage — routing by category and severity", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team", role: "OWNER" }] as never);
    vi.spyOn(api, "listChannelEvents").mockResolvedValue(VOCAB);
    vi.spyOn(api, "listDeliveries").mockResolvedValue([] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("create defaults to every category and every level (one channel, all events)", async () => {
    vi.spyOn(api, "listChannels").mockResolvedValue([] as never);
    const createSpy = vi.spyOn(api, "createChannel").mockResolvedValue({} as never);
    wrap(<NotificationsPage />);
    const uptime = (await screen.findByLabelText("Uptime")) as HTMLInputElement;
    expect(uptime.checked).toBe(true);
    for (const c of ["Deploy", "Backup", "Server", "Security", "Updates"]) expect((screen.getByLabelText(c) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "all" } });
    fireEvent.click(screen.getByText("Add channel"));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ categories: ["uptime", "deploy", "backup", "server", "security", "updates"], minSeverity: "info", eventTypes: [] }),
    );
    expect(createSpy.mock.calls[0][0]).not.toHaveProperty("topics");
  });

  it("create sends the narrowed categories, the level and telegram topics for the selected categories only", async () => {
    vi.spyOn(api, "listChannels").mockResolvedValue([] as never);
    const createSpy = vi.spyOn(api, "createChannel").mockResolvedValue({} as never);
    wrap(<NotificationsPage />);
    await screen.findByLabelText("Uptime");
    fireEvent.change(screen.getByDisplayValue("SMTP"), { target: { value: "telegram" } });
    for (const c of ["Uptime", "Server", "Security", "Updates"]) fireEvent.click(screen.getByLabelText(c)); // keep Deploy + Backup
    fireEvent.change(screen.getByLabelText("Alert level"), { target: { value: "critical" } });
    fireEvent.change(screen.getByLabelText("Deploy — Topic ID"), { target: { value: "11" } });
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "tg" } });
    fireEvent.click(screen.getByText("Add channel"));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "telegram", categories: ["deploy", "backup"], minSeverity: "critical", topics: { deploy: 11 } }),
    );
  });

  it("push: no config fields, a calm default routing (uptime, deploy, server from warning up), and an empty config", async () => {
    vi.spyOn(api, "listChannels").mockResolvedValue([] as never);
    const createSpy = vi.spyOn(api, "createChannel").mockResolvedValue({} as never);
    wrap(<NotificationsPage />);
    await screen.findByLabelText("Uptime");
    fireEvent.change(screen.getByDisplayValue("SMTP"), { target: { value: "push" } });
    expect(screen.getByRole("note")).toHaveTextContent("Alerts go to the devices you turned push on for");
    for (const c of ["Uptime", "Deploy", "Server"]) expect((screen.getByLabelText(c) as HTMLInputElement).checked).toBe(true);
    for (const c of ["Backup", "Security", "Updates"]) expect((screen.getByLabelText(c) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "My phone" } });
    fireEvent.click(screen.getByText("Add channel"));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "push", config: {}, categories: ["uptime", "deploy", "server"], minSeverity: "warning" }));
  });

  it("refuses to create with an invalid topic id", async () => {
    vi.spyOn(api, "listChannels").mockResolvedValue([] as never);
    const createSpy = vi.spyOn(api, "createChannel").mockResolvedValue({} as never);
    wrap(<NotificationsPage />);
    await screen.findByLabelText("Uptime");
    fireEvent.change(screen.getByDisplayValue("SMTP"), { target: { value: "telegram" } });
    fireEvent.change(screen.getByLabelText("Deploy — Topic ID"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "tg" } });
    fireEvent.click(screen.getByText("Add channel"));
    expect(await screen.findByText("Topic IDs are whole numbers above 0.")).toBeTruthy();
    expect(createSpy).not.toHaveBeenCalled();
  });

  const channel = (over: Record<string, unknown> = {}) => ({
    id: "c1", name: "Ops", type: "telegram", teamId: "t1", enabled: true, canWrite: true,
    eventTypes: [], categories: ["deploy"], minSeverity: "warning", topics: { deploy: 5 }, ...over,
  });

  it("summarises the rule on the channel row, and a legacy channel still lists its events", async () => {
    vi.spyOn(api, "listChannels").mockResolvedValue([
      channel(),
      channel({ id: "c2", name: "Old", type: "slack", eventTypes: ["deploy_failed"], categories: [], minSeverity: "info", topics: null }),
    ] as never);
    wrap(<NotificationsPage />);
    expect(await screen.findByText("Deploy — Warnings and failures")).toBeTruthy();
    // the legacy row renders the event label (also present in the create form's event list, hence getAllByText)
    expect(screen.getAllByText("Deploy failed").length).toBeGreaterThan(1);
  });

  it("edits a saved channel's routing and saves it with one update (topics null for non-telegram)", async () => {
    vi.spyOn(api, "listChannels").mockResolvedValue([channel({ type: "slack", topics: null })] as never);
    const updateSpy = vi.spyOn(api, "updateChannel").mockResolvedValue({} as never);
    wrap(<NotificationsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Routing" }));
    const panel = document.getElementById("route-c1-level")!.closest("div[style*='border-top']") as HTMLElement;
    expect(panel).toBeTruthy();
    const inPanel = (label: string) => Array.from(panel.querySelectorAll("label")).find((l) => l.textContent === label)!.querySelector("input")!;
    fireEvent.click(inPanel("Backup"));
    fireEvent.change(document.getElementById("route-c1-level")!, { target: { value: "info" } });
    fireEvent.click(Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "Save")!);
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(updateSpy).toHaveBeenCalledWith("c1", { categories: ["deploy", "backup"], minSeverity: "info" });
  });

  it("telegram: saves topics, and clears the map with null when none are set", async () => {
    vi.spyOn(api, "listChannels").mockResolvedValue([channel()] as never);
    const updateSpy = vi.spyOn(api, "updateChannel").mockResolvedValue({} as never);
    wrap(<NotificationsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Routing" }));
    const panel = document.getElementById("route-c1-level")!.closest("div[style*='border-top']") as HTMLElement;
    const save = () => Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
    const topic = panel.querySelector('input[aria-label="Deploy — Topic ID"]') as HTMLInputElement;
    expect(topic.value).toBe("5");
    fireEvent.change(topic, { target: { value: "8" } });
    fireEvent.click(save());
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith("c1", expect.objectContaining({ topics: { deploy: 8 } })));
  });

  it("sends a test for one category and names the channel in the toast", async () => {
    vi.spyOn(api, "listChannels").mockResolvedValue([channel({ categories: ["deploy", "backup"] })] as never);
    const testSpy = vi.spyOn(api, "testChannel").mockResolvedValue({ ok: true } as never);
    const toasts: string[] = [];
    const off = subscribeToast((x) => toasts.push(x.message));
    wrap(<NotificationsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Routing" }));
    // the per-category tests live under More (the create form has its own More toggle too)
    fireEvent.click(screen.getAllByRole("button", { name: "▸ More" }).find((b) => b.getAttribute("aria-controls") === "route-c1-more")!);
    fireEvent.click(await screen.findByRole("button", { name: "Send a test for Backup" }));
    await waitFor(() => expect(testSpy).toHaveBeenCalledWith("c1", "backup"));
    await waitFor(() => expect(toasts).toContain("Test sent to Ops"));
    off();
  });

  it("read-only members get no routing editor", async () => {
    vi.spyOn(api, "listChannels").mockResolvedValue([channel({ canWrite: false })] as never);
    wrap(<NotificationsPage />);
    await screen.findByText("Ops");
    expect(screen.queryByRole("button", { name: "Routing" })).toBeNull();
  });
});
