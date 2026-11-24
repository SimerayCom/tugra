import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ConfirmProvider } from "../../../components/confirm";
import { api } from "../../../lib/api";
import { subscribeToast } from "../../../lib/toast-bus";
import type { Channel, TeamDigest } from "../../../lib/types";
import NotificationsPage from "./page";
import { ChannelPolicyPanel } from "./policy-panel";
import { DigestCard } from "./digest-card";

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

const CHANNEL: Channel = { id: "c1", name: "Ops chat", type: "slack", teamId: "t1", enabled: true, canWrite: true, eventTypes: [], categories: ["deploy"], minSeverity: "info", topics: null };
const VOCAB = {
  events: ["deploy_failed"],
  categories: ["uptime", "deploy", "backup", "server", "security", "updates"],
  severities: ["info", "warning", "critical"],
};

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => vi.restoreAllMocks());

describe("ChannelPolicyPanel", () => {
  it("starts with quiet hours off and saves nothing but defaults", async () => {
    const spy = vi.spyOn(api, "updateChannel").mockResolvedValue({} as never);
    wrap(<ChannelPolicyPanel channel={CHANNEL} onClose={() => {}} />);
    expect((screen.getByLabelText("Hold alerts during quiet hours") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText("From")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("c1", { policy: { quietHours: null, rateLimitPerMin: null, dedupeWindowSec: null } });
  });

  it("saves quiet hours, a rate limit and a repeat window", async () => {
    const spy = vi.spyOn(api, "updateChannel").mockResolvedValue({} as never);
    const toasts: string[] = [];
    const off = subscribeToast((x) => toasts.push(x.message));
    const onClose = vi.fn();
    wrap(<ChannelPolicyPanel channel={CHANNEL} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Hold alerts during quiet hours"));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "23:00" } });
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: "06:30" } });
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/Berlin" } });
    fireEvent.click(screen.getByLabelText("Still send failures"));
    fireEvent.change(screen.getByLabelText("Messages per minute"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Repeated alerts"), { target: { value: "600" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("c1", {
      policy: { quietHours: { from: "23:00", to: "06:30", tz: "Europe/Berlin", allowCritical: false }, rateLimitPerMin: 12, dedupeWindowSec: 600 },
    });
    await waitFor(() => expect(toasts).toContain("Delivery rules saved"));
    expect(onClose).toHaveBeenCalled();
    off();
  });

  it("shows what to fix and sends nothing when the draft is invalid", async () => {
    const spy = vi.spyOn(api, "updateChannel").mockResolvedValue({} as never);
    wrap(<ChannelPolicyPanel channel={CHANNEL} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Messages per minute"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Messages per minute must be a whole number from 1 to 600.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("loads the saved rules", () => {
    wrap(
      <ChannelPolicyPanel
        channel={{ ...CHANNEL, policy: { quietHours: { from: "21:00", to: "05:00", tz: "UTC", allowCritical: true }, rateLimitPerMin: 8, dedupeWindowSec: 0 } }}
        onClose={() => {}}
      />,
    );
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("21:00");
    expect((screen.getByLabelText("Messages per minute") as HTMLInputElement).value).toBe("8");
    expect((screen.getByLabelText("Repeated alerts") as HTMLSelectElement).value).toBe("0");
  });
});

describe("DigestCard", () => {
  const DIGEST: TeamDigest = { teamId: "t1", enabled: false, channelId: null, channelName: null, lastSentAt: null, hour: 8, timezone: "Europe/Berlin" };

  it("is opt-in: off by default, and turning it on picks the first channel", async () => {
    vi.spyOn(api, "getTeamDigest").mockResolvedValue(DIGEST);
    const update = vi.spyOn(api, "updateTeamDigest").mockResolvedValue({ ...DIGEST, enabled: true, channelId: "c1", channelName: "Ops chat" });
    wrap(<DigestCard teamId="t1" channels={[CHANNEL]} canWrite />);
    const box = (await screen.findByLabelText("Send the weekly digest")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText("Off. Nothing is sent until you turn it on.")).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(update).toHaveBeenCalledWith("t1", { enabled: true, channelId: "c1" }));
    expect(await screen.findByText("Mondays at 08:00 (Europe/Berlin).")).toBeTruthy();
  });

  it("only offers this team's channels and can send one now", async () => {
    vi.spyOn(api, "getTeamDigest").mockResolvedValue({ ...DIGEST, enabled: true, channelId: "c1", channelName: "Ops chat" });
    const send = vi.spyOn(api, "sendTeamDigest").mockResolvedValue({ ok: true });
    const toasts: string[] = [];
    const off = subscribeToast((x) => toasts.push(x.message));
    wrap(<DigestCard teamId="t1" channels={[CHANNEL, { ...CHANNEL, id: "c2", name: "Other team", teamId: "t2" }]} canWrite />);
    const select = (await screen.findByLabelText("Send it to")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["Pick a channel", "Ops chat"]);
    fireEvent.click(screen.getByRole("button", { name: "Send this week's now" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(toasts).toContain("Digest sent"));
    off();
  });

  it("a viewer sees the setting but cannot change it", async () => {
    vi.spyOn(api, "getTeamDigest").mockResolvedValue({ ...DIGEST, enabled: true, channelId: "c1", channelName: "Ops chat" });
    wrap(<DigestCard teamId="t1" channels={[CHANNEL]} canWrite={false} />);
    expect(((await screen.findByLabelText("Send the weekly digest")) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Send it to") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Send this week's now" })).toBeNull();
  });

  it("asks for a channel first when the team has none", async () => {
    vi.spyOn(api, "getTeamDigest").mockResolvedValue(DIGEST);
    wrap(<DigestCard teamId="t1" channels={[]} canWrite />);
    expect(await screen.findByText("Add a channel for this team to send the digest to.")).toBeTruthy();
    expect(screen.queryByLabelText("Send the weekly digest")).toBeNull();
  });

  it("surfaces a failed send", async () => {
    vi.spyOn(api, "getTeamDigest").mockResolvedValue({ ...DIGEST, enabled: true, channelId: "c1", channelName: "Ops chat" });
    vi.spyOn(api, "sendTeamDigest").mockRejectedValue(new Error("matrix: HTTP 403"));
    wrap(<DigestCard teamId="t1" channels={[CHANNEL]} canWrite />);
    fireEvent.click(await screen.findByRole("button", { name: "Send this week's now" }));
    expect((await screen.findByRole("alert")).textContent).toBe("matrix: HTTP 403");
  });
});

describe("NotificationsPage — new channel types and URL setup", () => {
  beforeEach(() => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team", role: "OWNER" }] as never);
    vi.spyOn(api, "listChannels").mockResolvedValue([] as never);
    vi.spyOn(api, "listChannelEvents").mockResolvedValue(VOCAB);
    vi.spyOn(api, "getTeamDigest").mockResolvedValue({ teamId: "t1", enabled: false, channelId: null, channelName: null, lastSentAt: null, hour: 8, timezone: "UTC" });
  });

  it("offers every new service by name", async () => {
    wrap(<NotificationsPage />);
    const select = (await screen.findByDisplayValue("SMTP")) as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.text);
    for (const l of ["Matrix", "Google Chat", "Rocket.Chat", "PagerDuty", "Opsgenie", "Zulip", "Bark", "Signal", "SMS (Twilio)"]) expect(labels).toContain(l);
  });

  it("matrix: shows its fields and leaves cleared ones out of the config", async () => {
    const create = vi.spyOn(api, "createChannel").mockResolvedValue({} as never);
    wrap(<NotificationsPage />);
    fireEvent.change(await screen.findByDisplayValue("SMTP"), { target: { value: "matrix" } });
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "Ops room" } });
    fireEvent.change(screen.getByLabelText("Homeserver URL"), { target: { value: "https://matrix.example.com" } });
    fireEvent.change(screen.getByLabelText("Room"), { target: { value: "!abc:example.com" } });
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "syt_x" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "bot" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "" } });
    expect((screen.getByLabelText("Access token") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Add channel" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ type: "matrix", config: { homeserver: "https://matrix.example.com", roomId: "!abc:example.com", accessToken: "syt_x" } });
    expect(create.mock.calls[0][0].config).not.toHaveProperty("user");
  });

  it("sms: labels the numbers as numbers", async () => {
    wrap(<NotificationsPage />);
    fireEvent.change(await screen.findByDisplayValue("SMTP"), { target: { value: "sms" } });
    expect(screen.getByLabelText("From number")).toBeTruthy();
    expect(screen.getByLabelText("To number")).toBeTruthy();
    expect((screen.getByLabelText("Auth token") as HTMLInputElement).type).toBe("password");
  });

  it("URL mode: check shows a masked preview, then add creates the channel", async () => {
    const parse = vi.spyOn(api, "parseChannelUrl").mockResolvedValue({
      type: "telegram",
      suggestedName: "Telegram",
      config: { botToken: "••••", chatId: "@alerts" },
    });
    const create = vi.spyOn(api, "createChannelFromUrl").mockResolvedValue({} as never);
    wrap(<NotificationsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "From a URL" }));
    fireEvent.change(screen.getByLabelText("Channel URL"), { target: { value: "tgram://123456789:abcdefghij@telegram?chats=@alerts" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Looks like Telegram")).toBeTruthy();
    expect(parse).toHaveBeenCalledWith({ teamId: "t1", url: "tgram://123456789:abcdefghij@telegram?chats=@alerts" });
    expect(screen.getByText("@alerts")).toBeTruthy();
    expect(screen.getByText("••••")).toBeTruthy();
    expect(screen.queryByText(/abcdefghij/, { selector: "dd" })).toBeNull(); // the token is never shown back
    expect((screen.getByLabelText("Channel name") as HTMLInputElement).value).toBe("Telegram");
    fireEvent.click(screen.getByRole("button", { name: "Add channel" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "t1", url: "tgram://123456789:abcdefghij@telegram?chats=@alerts", name: "Telegram", minSeverity: "info" }),
    );
    // the pasted URL is a secret: gone from the form once the channel exists
    await waitFor(() => expect((screen.getByLabelText("Channel URL") as HTMLInputElement).value).toBe(""));
  });

  it("URL mode: a rejected URL shows the reason, and editing the URL needs a new check", async () => {
    vi.spyOn(api, "parseChannelUrl").mockRejectedValueOnce(new Error("that URL scheme is not supported")).mockResolvedValue({ type: "ntfy", suggestedName: "ntfy — alerts", config: { topic: "alerts" } });
    wrap(<NotificationsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "From a URL" }));
    const field = screen.getByLabelText("Channel URL");
    fireEvent.change(field, { target: { value: "gopher://x" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect((await screen.findByRole("alert")).textContent).toBe("that URL scheme is not supported");
    fireEvent.change(field, { target: { value: "ntfy://alerts" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Looks like ntfy")).toBeTruthy();
    fireEvent.change(field, { target: { value: "ntfy://alerts2" } });
    expect(screen.queryByText("Looks like ntfy")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add channel" })).toBeNull();
  });

  it("lists a channel's active delivery rules and opens the rules editor", async () => {
    vi.spyOn(api, "listChannels").mockResolvedValue([{ ...CHANNEL, policy: { rateLimitPerMin: 5, quietHours: { from: "22:00", to: "07:00", tz: "UTC", allowCritical: true } } }] as never);
    vi.spyOn(api, "listDeliveries").mockResolvedValue([] as never);
    wrap(<NotificationsPage />);
    expect(await screen.findByText(/quiet hours · rate limit/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delivery rules" }));
    expect(await screen.findByLabelText("Hold alerts during quiet hours")).toBeTruthy();
  });
});
