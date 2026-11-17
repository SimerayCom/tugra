import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ServerRebootCard } from "./server-reboot-card";
import { api } from "../lib/api";
import { rebootPollMs, toLocalInputValue, fromLocalInputValue } from "../lib/reboot";
import type { RebootPreview, RebootReport, RebootState, RebootStatus, RebootView } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

const card = (over: { canWrite?: boolean } = {}) => <ServerRebootCard id="s1" serverName="prod-1" canWrite={over.canWrite ?? true} />;

const report = (over: Partial<RebootReport> = {}): RebootReport => ({
  version: 1,
  checkedAt: "2026-11-27T12:09:00.000Z",
  rebooted: true,
  docker: "active",
  containers: [
    { name: "web", image: "nginx:1.27", restartPolicy: "unless-stopped", hadHealthcheck: true, verdict: "ok", detail: "healthy" },
    { name: "db", image: "postgres:16", restartPolicy: "always", hadHealthcheck: false, verdict: "ok" },
    { name: "scratch", image: "busybox", restartPolicy: "no", hadHealthcheck: false, verdict: "skipped" },
  ],
  domains: [{ host: "app.example.com", verdict: "ok", status: 200 }],
  rebootRequired: "cleared",
  summary: { containersOk: 2, containersExpected: 2, domainsOk: 1, domainsExpected: 1 },
  ...over,
});

const view = (over: Partial<RebootView> = {}): RebootView => ({
  id: "rb1",
  serverId: "s1",
  mode: "now",
  state: "REBOOTING",
  result: null,
  requestedBy: "u1",
  scheduledAt: null,
  startedAt: "2026-11-27T12:00:00.000Z",
  agentBackAt: null,
  verifiedAt: null,
  createdAt: "2026-11-27T11:59:50.000Z",
  snapshot: { containers: 3, domains: 1, hostsHub: false },
  report: null,
  ...over,
});

const done = (result: "ok" | "degraded" | "failed", r: RebootReport | null): RebootView => view({ state: "DONE", result, verifiedAt: "2026-11-27T12:09:30.000Z", agentBackAt: "2026-11-27T12:03:00.000Z", report: r });

const preview = (over: Partial<RebootPreview> = {}): RebootPreview => ({ containers: 7, domains: 3, hostsHub: false, agentOnline: true, ...over });

function stubStatus(s: Partial<RebootStatus> = {}) {
  return vi.spyOn(api, "getServerReboot").mockResolvedValue({ active: null, last: null, ...s });
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => vi.restoreAllMocks());

describe("idle card", () => {
  it("offers 'Reboot now' and 'Schedule…' to an operator, and nothing else", async () => {
    stubStatus();
    wrap(card());
    expect(screen.getByRole("button", { name: "Reboot now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Schedule…" })).toBeTruthy();
    expect(screen.queryByTestId("reboot-live")).toBeNull();
  });

  it("a viewer sees no reboot buttons", async () => {
    stubStatus();
    wrap(card({ canWrite: false }));
    expect(screen.queryByRole("button", { name: "Reboot now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Schedule…" })).toBeNull();
    expect(screen.getByText(/operator role/)).toBeTruthy();
  });
});

describe("Reboot now: impact preview and typed confirmation", () => {
  async function open(p: RebootPreview = preview()) {
    stubStatus();
    vi.spyOn(api, "getServerRebootPreview").mockResolvedValue(p);
    wrap(card());
    fireEvent.click(screen.getByRole("button", { name: "Reboot now" }));
    await screen.findByRole("dialog");
    return screen.getByRole("dialog");
  }
  const confirmBtn = (dlg: HTMLElement) => within(dlg).getByRole("button", { name: "Reboot now" }) as HTMLButtonElement;
  const typedField = (dlg: HTMLElement) => within(dlg).getByLabelText(/Type the server name prod-1/) as HTMLInputElement;

  it("shows what will be unavailable: N containers and M domains", async () => {
    const dlg = await open();
    await waitFor(() => expect(within(dlg).getByTestId("reboot-impact").textContent).toContain("7 containers and 3 domains will be briefly unavailable."));
    expect(within(dlg).queryByText(/hosts the Tugra hub/i)).toBeNull();
  });

  it("warns that the panel goes away for 1 to 3 minutes when this server hosts the hub", async () => {
    const dlg = await open(preview({ hostsHub: true }));
    await waitFor(() => expect(within(dlg).getByRole("note").textContent).toMatch(/runs the Tugra hub itself.*panel will go away for 1 to 3 minutes/));
  });

  it("the confirm button stays disabled until the server's name is typed exactly", async () => {
    const dlg = await open();
    await waitFor(() => expect(within(dlg).getByTestId("reboot-impact").textContent).toContain("7 containers"));
    expect(confirmBtn(dlg).disabled).toBe(true);
    for (const wrong of ["prod", "PROD-1", "prod-1 ", "prod-12", " prod-1"]) {
      fireEvent.change(typedField(dlg), { target: { value: wrong } });
      expect(confirmBtn(dlg).disabled, wrong).toBe(true);
    }
    fireEvent.change(typedField(dlg), { target: { value: "prod-1" } });
    expect(confirmBtn(dlg).disabled).toBe(false);
  });

  it("sends nothing before the name is typed; then requests an immediate reboot with the typed name", async () => {
    const req = vi.spyOn(api, "requestServerReboot").mockResolvedValue(view());
    const dlg = await open();
    fireEvent.click(confirmBtn(dlg)); // disabled: no call
    expect(req).not.toHaveBeenCalled();
    fireEvent.change(typedField(dlg), { target: { value: "prod-1" } });
    fireEvent.click(confirmBtn(dlg));
    await waitFor(() => expect(req).toHaveBeenCalledWith("s1", { mode: "now", confirmName: "prod-1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); // closes, the live panel takes over
  });

  it("Enter in the field confirms only when it is allowed", async () => {
    const req = vi.spyOn(api, "requestServerReboot").mockResolvedValue(view());
    const dlg = await open();
    fireEvent.keyDown(typedField(dlg), { key: "Enter" });
    expect(req).not.toHaveBeenCalled();
    fireEvent.change(typedField(dlg), { target: { value: "prod-1" } });
    fireEvent.keyDown(typedField(dlg), { key: "Enter" });
    await waitFor(() => expect(req).toHaveBeenCalledTimes(1));
  });

  it("an offline agent blocks the reboot and says why", async () => {
    const dlg = await open(preview({ agentOnline: false }));
    await waitFor(() => expect(within(dlg).getByText(/agent is offline/)).toBeTruthy());
    fireEvent.change(typedField(dlg), { target: { value: "prod-1" } });
    expect(confirmBtn(dlg).disabled).toBe(true);
  });

  it("a refusal from the hub (409: a deploy is running) is shown and the dialog stays open", async () => {
    vi.spyOn(api, "requestServerReboot").mockRejectedValue(new Error("a deploy is running on this server — wait for it to finish before rebooting"));
    const dlg = await open();
    fireEvent.change(typedField(dlg), { target: { value: "prod-1" } });
    fireEvent.click(confirmBtn(dlg));
    await waitFor(() => expect(within(dlg).getByRole("alert").textContent).toContain("a deploy is running"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("when the preview cannot be read it says so but does not block the reboot", async () => {
    stubStatus();
    vi.spyOn(api, "getServerRebootPreview").mockRejectedValue(new Error("boom"));
    wrap(card());
    fireEvent.click(screen.getByRole("button", { name: "Reboot now" }));
    const dlg = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dlg).getByText(/Could not read what is running/)).toBeTruthy());
    fireEvent.change(typedField(dlg), { target: { value: "prod-1" } });
    expect(confirmBtn(dlg).disabled).toBe(false);
  });

  it("Cancel closes without sending", async () => {
    const req = vi.spyOn(api, "requestServerReboot").mockResolvedValue(view());
    const dlg = await open();
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(req).not.toHaveBeenCalled();
  });
});

describe("Schedule", () => {
  async function open() {
    stubStatus();
    vi.spyOn(api, "getServerRebootPreview").mockResolvedValue(preview());
    wrap(card());
    fireEvent.click(screen.getByRole("button", { name: "Schedule…" }));
    await screen.findByRole("dialog");
    return screen.getByRole("dialog");
  }
  const picker = (dlg: HTMLElement) => within(dlg).getByLabelText("Reboot at") as HTMLInputElement;
  const confirmBtn = (dlg: HTMLElement) => within(dlg).getByRole("button", { name: "Schedule reboot" }) as HTMLButtonElement;
  const typedField = (dlg: HTMLElement) => within(dlg).getByLabelText(/Type the server name prod-1/) as HTMLInputElement;

  it("starts with a valid time, shows it in local time AND as the UTC instant that is stored", async () => {
    const dlg = await open();
    const iso = fromLocalInputValue(picker(dlg).value)!;
    expect(iso).toMatch(/Z$/);
    const utc = iso.slice(0, 16).replace("T", " ") + " UTC";
    expect(within(dlg).getByText(new RegExp(`Stored as ${utc}`))).toBeTruthy();
    expect(within(dlg).getByText(/Local time:/)).toBeTruthy();
  });

  it("refuses a time in the past or beyond 7 days, and re-enables for a good one", async () => {
    const dlg = await open();
    fireEvent.change(typedField(dlg), { target: { value: "prod-1" } });
    fireEvent.change(picker(dlg), { target: { value: toLocalInputValue(new Date(Date.now() - 3600_000)) } });
    expect(within(dlg).getByText("Pick a time at least a minute from now.")).toBeTruthy();
    expect(confirmBtn(dlg).disabled).toBe(true);
    fireEvent.change(picker(dlg), { target: { value: toLocalInputValue(new Date(Date.now() + 9 * 24 * 3600_000)) } });
    expect(within(dlg).getByText("Pick a time within the next 7 days.")).toBeTruthy();
    expect(confirmBtn(dlg).disabled).toBe(true);
    fireEvent.change(picker(dlg), { target: { value: toLocalInputValue(new Date(Date.now() + 3 * 3600_000)) } });
    expect(confirmBtn(dlg).disabled).toBe(false);
  });

  it("needs the typed name too, then sends the picked instant as UTC", async () => {
    const req = vi.spyOn(api, "requestServerReboot").mockResolvedValue(view({ mode: "scheduled", state: "SCHEDULED" }));
    const dlg = await open();
    const local = toLocalInputValue(new Date(Date.now() + 3 * 3600_000));
    fireEvent.change(picker(dlg), { target: { value: local } });
    expect(confirmBtn(dlg).disabled).toBe(true); // name not typed yet
    fireEvent.change(typedField(dlg), { target: { value: "prod-1" } });
    fireEvent.click(confirmBtn(dlg));
    await waitFor(() => expect(req).toHaveBeenCalledWith("s1", { mode: "scheduled", at: fromLocalInputValue(local), confirmName: "prod-1" }));
  });
});

describe("live state", () => {
  const cases: [RebootState, string, string][] = [
    ["SCHEDULED", "Scheduled", "Nothing happens until then"],
    ["STARTING", "Rebooting", "going down"],
    ["REBOOTING", "Rebooting", "going down"],
    ["WAITING_AGENT", "Waiting for the agent", "Waiting for the agent to reconnect"],
    ["VERIFYING", "Verifying", "Checking that every container and domain came back"],
  ];
  it.each(cases)("%s: marks the current step and explains it; the reboot buttons are gone", async (state, step, hint) => {
    stubStatus({ active: view({ state, mode: state === "SCHEDULED" ? "scheduled" : "now", scheduledAt: state === "SCHEDULED" ? "2026-11-27T15:30:00.000Z" : null }) });
    wrap(card());
    const live = await screen.findByTestId("reboot-live");
    expect(live.getAttribute("data-state")).toBe(state);
    const current = within(live).getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain(step);
    expect(live.textContent).toContain(hint);
    expect(screen.queryByRole("button", { name: "Reboot now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Schedule…" })).toBeNull();
  });

  it("an immediate reboot has no 'Scheduled' step; only the last step is current once verifying", async () => {
    stubStatus({ active: view({ state: "VERIFYING" }) });
    wrap(card());
    const live = await screen.findByTestId("reboot-live");
    const items = within(live).getAllByRole("listitem");
    expect(items.map((li) => li.textContent?.replace(/^@keyframes[^}]*\}\}/, ""))).toEqual(["Rebooting", "Waiting for the agent", "Verifying"]);
    expect(items.map((li) => li.getAttribute("aria-current"))).toEqual([null, null, "step"]);
  });

  it("a scheduled reboot shows its time (local + UTC) and can be cancelled by an operator", async () => {
    stubStatus({ active: view({ state: "SCHEDULED", mode: "scheduled", scheduledAt: "2026-11-27T15:30:00.000Z" }) });
    const cancel = vi.spyOn(api, "cancelServerReboot").mockResolvedValue(done("ok", null));
    wrap(card());
    const live = await screen.findByTestId("reboot-live");
    expect(live.textContent).toContain("2026-11-27 15:30 UTC");
    expect(live.textContent).toContain("Scheduled for");
    fireEvent.click(within(live).getByRole("button", { name: "Cancel scheduled reboot" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("s1"));
  });

  it("a viewer cannot cancel a scheduled reboot", async () => {
    stubStatus({ active: view({ state: "SCHEDULED", mode: "scheduled", scheduledAt: "2026-11-27T15:30:00.000Z" }) });
    wrap(card({ canWrite: false }));
    await screen.findByTestId("reboot-live");
    expect(screen.queryByRole("button", { name: "Cancel scheduled reboot" })).toBeNull();
  });

  it("a reboot that is already running offers no cancel", async () => {
    stubStatus({ active: view({ state: "REBOOTING" }) });
    wrap(card());
    await screen.findByTestId("reboot-live");
    expect(screen.queryByRole("button", { name: "Cancel scheduled reboot" })).toBeNull();
  });

  it("warns that the panel goes away when the rebooting server hosts the hub", async () => {
    stubStatus({ active: view({ state: "REBOOTING", snapshot: { containers: 3, domains: 1, hostsHub: true } }) });
    wrap(card());
    const live = await screen.findByTestId("reboot-live");
    expect(live.textContent).toMatch(/panel will go away for 1 to 3 minutes/);
  });

  it("keeps polling a live reboot and follows it through to the report, by itself", async () => {
    const original = rebootPollMs.live;
    rebootPollMs.live = 15;
    try {
      const get = vi
        .spyOn(api, "getServerReboot")
        .mockResolvedValueOnce({ active: view({ state: "REBOOTING" }), last: null })
        .mockResolvedValueOnce({ active: view({ state: "WAITING_AGENT" }), last: null })
        .mockResolvedValueOnce({ active: view({ state: "VERIFYING" }), last: null })
        .mockResolvedValue({ active: null, last: done("ok", report()) });
      wrap(card());
      await waitFor(() => expect(screen.getByTestId("reboot-live").getAttribute("data-state")).toBe("REBOOTING"));
      await waitFor(() => expect(screen.getByTestId("reboot-live").getAttribute("data-state")).toBe("WAITING_AGENT"));
      await waitFor(() => expect(screen.getByTestId("reboot-live").getAttribute("data-state")).toBe("VERIFYING"));
      await waitFor(() => expect(screen.getByTestId("reboot-report")).toBeTruthy());
      expect(screen.queryByTestId("reboot-live")).toBeNull();
      expect(screen.getByRole("button", { name: "Reboot now" })).toBeTruthy();
      const calls = get.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80));
      expect(get.mock.calls.length).toBe(calls); // nothing live any more: polling stops
    } finally {
      rebootPollMs.live = original;
    }
  });

  it("while the hub itself is rebooting the card keeps its state, says why, and recovers when the hub answers again", async () => {
    const original = rebootPollMs.live;
    rebootPollMs.live = 15;
    try {
      vi.spyOn(api, "getServerReboot")
        .mockResolvedValueOnce({ active: view({ state: "REBOOTING", snapshot: { containers: 3, domains: 1, hostsHub: true } }), last: null })
        .mockRejectedValueOnce(new Error("hub unreachable"))
        .mockRejectedValueOnce(new Error("hub unreachable"))
        .mockResolvedValue({ active: view({ state: "VERIFYING" }), last: null });
      wrap(card());
      await screen.findByTestId("reboot-live");
      await waitFor(() => expect(screen.getByText(/can't reach the hub right now/)).toBeTruthy());
      expect(screen.getByTestId("reboot-live").getAttribute("data-state")).toBe("REBOOTING"); // last known state stays
      await waitFor(() => expect(screen.getByTestId("reboot-live").getAttribute("data-state")).toBe("VERIFYING"));
      expect(screen.queryByText(/can't reach the hub right now/)).toBeNull();
    } finally {
      rebootPollMs.live = original;
    }
  });
});

describe("last verification report", () => {
  it("OK: summary, every container and domain with its verdict, 'not expected back' for a no-restart container", async () => {
    stubStatus({ last: done("ok", report()) });
    wrap(card());
    const rep = await screen.findByTestId("reboot-report");
    expect(within(rep).getByText("Everything came back")).toBeTruthy();
    expect(rep.textContent).toContain("2 of 2 containers running, 1 of 1 domains answering");
    const containers = within(within(rep).getByTestId("reboot-containers")).getAllByRole("listitem");
    expect(containers.map((li) => li.textContent)).toEqual([
      expect.stringContaining("web"),
      expect.stringContaining("db"),
      expect.stringContaining("scratch"),
    ]);
    expect(within(containers[0]).getByText("Running")).toBeTruthy();
    expect(containers[0].textContent).toContain("nginx:1.27");
    expect(containers[0].textContent).toContain("restart: unless-stopped");
    expect(within(containers[2]).getByText("Not expected back")).toBeTruthy();
    const domains = within(within(rep).getByTestId("reboot-domains")).getAllByRole("listitem");
    expect(domains[0].textContent).toContain("app.example.com");
    expect(within(domains[0]).getByText("Answering")).toBeTruthy();
  });

  it("degraded: names the container that is not back, the unhealthy one and the domain that does not answer", async () => {
    const r = report({
      containers: [
        { name: "web", image: "nginx", restartPolicy: "always", hadHealthcheck: true, verdict: "unhealthy", detail: "unhealthy" },
        { name: "db", image: "postgres", restartPolicy: "always", hadHealthcheck: false, verdict: "missing", detail: "exited" },
      ],
      domains: [
        { host: "a.example.com", verdict: "not_answering", status: 502 },
        { host: "b.example.com", verdict: "ok", status: 301 },
      ],
      rebootRequired: "still_set",
      summary: { containersOk: 0, containersExpected: 2, domainsOk: 1, domainsExpected: 2 },
    });
    stubStatus({ last: done("degraded", r) });
    wrap(card());
    const rep = await screen.findByTestId("reboot-report");
    expect(within(rep).getByText("Some things did not come back")).toBeTruthy();
    expect(within(rep).getByText("Unhealthy")).toBeTruthy();
    expect(within(rep).getByText("Not back")).toBeTruthy();
    expect(within(rep).getByText("Not answering")).toBeTruthy();
    expect(rep.textContent).toContain("a.example.com · 502");
    expect(within(rep).getByText("The server still asks for a reboot.")).toBeTruthy();
  });

  it("failed: shows why in words and no per-item rows", async () => {
    stubStatus({ last: done("failed", { ...report(), containers: [], domains: [], reason: "agent_never_returned", docker: "unknown", summary: { containersOk: 0, containersExpected: 2, domainsOk: 0, domainsExpected: 1 } }) });
    wrap(card());
    const rep = await screen.findByTestId("reboot-report");
    expect(within(rep).getByText("Failed")).toBeTruthy();
    expect(within(rep).getByRole("alert").textContent).toContain("agent did not come back in time");
    expect(within(rep).queryByTestId("reboot-containers")).toBeNull();
  });

  it("notes domains that could not be checked instead of pretending they answered", async () => {
    stubStatus({ last: done("degraded", report({ domainsNote: "probe_unavailable", domains: [{ host: "a.example.com", verdict: "unverified", status: null }], summary: { containersOk: 2, containersExpected: 2, domainsOk: 0, domainsExpected: 0 } })) });
    wrap(card());
    const rep = await screen.findByTestId("reboot-report");
    expect(rep.textContent).toContain("the probe could not run");
    expect(within(rep).getByText("Not checked")).toBeTruthy();
  });

  it("no report block when there has never been a reboot", async () => {
    stubStatus();
    wrap(card());
    await waitFor(() => expect(api.getServerReboot).toHaveBeenCalled());
    expect(screen.queryByTestId("reboot-report")).toBeNull();
  });
});

// act is imported for symmetry with the other card tests; the polling tests above rely on waitFor.
void act;
