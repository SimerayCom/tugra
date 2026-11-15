import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { MoveAppModal } from "./move-app-modal";
import { ApiError, api } from "../lib/api";
import type { MovePreflightResult, ServerView } from "../lib/types";

const toast = vi.hoisted(() => vi.fn());
vi.mock("./toast", () => ({ useToast: () => toast }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SERVERS = [
  { id: "s1", name: "alpha", status: "ONLINE", teamId: "t1" },
  { id: "s2", name: "beta", status: "ONLINE", teamId: "t1" },
  { id: "s3", name: "gamma", status: "OFFLINE", teamId: "t1" },
  { id: "s9", name: "elsewhere", status: "ONLINE", teamId: "t2" },
] as unknown as ServerView[];

const result = (over: Partial<MovePreflightResult> = {}): MovePreflightResult => ({
  ok: true,
  blockers: [],
  warnings: [{ code: "history_splits" }, { code: "downtime_estimate", details: { lowSec: 30, highSec: 90 } }, { code: "env_may_reference_old_host", details: { keys: ["PUBLIC_URL", "API_URL"] } }],
  requiredAcks: [],
  plan: {
    cheap: false,
    volumes: [{ name: "data", dockerName: "tugra_appv_a1_data", kind: "app", sizeBytes: 2 * 1024 ** 3, state: "move" }],
    totalBytes: 2 * 1024 ** 3,
    partBytes: 256 * 1024 ** 2,
    estimatedParts: 8,
    sourceStagingFreeBytes: null,
    targetFreeBytes: null,
    estimatedDowntimeSec: { low: 90, high: 270 },
    domain: { kind: "magic", from: "blog.1-2-3-4.sslip.io", to: "blog.5-6-7-8.sslip.io" },
    hostPort: { from: 8080, to: 20001 },
    targetIp: "5.6.7.8",
    link: null,
  },
  ...over,
});

let qc: QueryClient;
const onClose = vi.fn();
const onStarted = vi.fn();
function show() {
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MoveAppModal appId="a1" appName="blog" teamId="t1" currentServerId="s1" onClose={onClose} onStarted={onStarted} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function pickTargetAndContinue(target = "s2") {
  const select = (await screen.findByLabelText("Target server")) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: target } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("MoveAppModal", () => {
  let preview: ReturnType<typeof vi.spyOn>;
  let start: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    onClose.mockClear();
    onStarted.mockClear();
    toast.mockClear();
    vi.spyOn(api, "listServers").mockResolvedValue(SERVERS);
    preview = vi.spyOn(api, "previewAppMove").mockResolvedValue(result());
    start = vi.spyOn(api, "startAppMove").mockResolvedValue({ moveId: "mv1", phase: "QUEUED" });
  });

  it("step 1 lists same-team servers only, excludes the current one and disables an offline one with the reason", async () => {
    show();
    const select = (await screen.findByLabelText("Target server")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    const opts = Array.from(select.options).map((o) => [o.value, o.textContent, o.disabled]);
    expect(opts).toEqual([["", "Select…", true], ["s2", "beta", false], ["s3", "gamma (offline)", true]]);
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true); // no target yet
  });

  it("runs the read-only preflight for the chosen target and moves to the review step", async () => {
    show();
    await pickTargetAndContinue();
    await waitFor(() => expect(preview).toHaveBeenCalledWith("a1", { targetServerId: "s2", probeLink: false }));
    expect(await screen.findByText(/Estimated downtime: 1m 30s to 4m 30s/)).toBeTruthy();
    // the plan: data size + parts, the domain + port changes, the new address, the volume card
    expect(screen.getByText(/Data to copy: 2.0 GB in 8 part/)).toBeTruthy();
    expect(screen.getByText("Domain: blog.1-2-3-4.sslip.io → blog.5-6-7-8.sslip.io")).toBeTruthy();
    expect(screen.getByText("Host port: 8080 → 20001")).toBeTruthy();
    expect(screen.getByText("New server address: 5.6.7.8")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Volumes" })).getByText("data")).toBeTruthy();
    // the plain statement that this is a COLD move
    expect(screen.getByText(/This is a COLD move/)).toBeTruthy();
    // warnings use the translated text with their details; the estimate is not repeated as a warning
    expect(screen.getByText(/Some environment variables mention the old server \(PUBLIC_URL, API_URL\)/)).toBeTruthy();
    expect(screen.getByText(/Metrics and traffic history split/)).toBeTruthy();
    expect(screen.queryByText(/Estimated downtime: 30 to 90 seconds/)).toBeNull();
  });

  it("hard blockers are red, each with its translated hint, and Continue stays disabled (an unknown code falls back to the hub's text)", async () => {
    preview.mockResolvedValue(
      result({
        ok: false,
        blockers: [
          { code: "agent_offline_target", message: "x" },
          { code: "ports_conflict", message: "x", details: { ports: [9000, 9001] } },
          { code: "brand_new_code", message: "The hub's own words" },
        ],
      }),
    );
    show();
    await pickTargetAndContinue();
    const list = await screen.findByRole("list", { name: "Must be fixed first" });
    expect(within(list).getByText("The target server is offline. Pick another one or bring it back online.")).toBeTruthy();
    expect(within(list).getByText(/Ports this app publishes are already in use/)).toBeTruthy();
    expect(within(list).getByText("The hub's own words")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
  });

  it("every required acknowledgement must be ticked before Continue; only the ticked ones are sent", async () => {
    preview.mockResolvedValue(
      result({
        ok: false,
        blockers: [{ code: "host_mounts", message: "", ack: true }, { code: "domain_changes", message: "", ack: true }],
        requiredAcks: ["hostMounts", "domainChanges"],
      }),
    );
    show();
    await pickTargetAndContinue();
    await screen.findByText("What will happen"); // the review step is up (step 1 also has a Continue button)
    const cont = screen.getByRole("button", { name: "Continue" });
    expect(cont).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText("I understand that data in host bind mounts is NOT copied."));
    expect(cont).toHaveProperty("disabled", true); // one of two
    fireEvent.click(screen.getByLabelText("I understand the app's domain(s) change or must be pointed at the new server."));
    expect(cont).toHaveProperty("disabled", false);
    fireEvent.click(cont);
    // step 3: typing the exact app name gates the start
    const input = await screen.findByLabelText("Type the app name to confirm");
    const submit = screen.getByRole("button", { name: "Move app" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "blo" } });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "blog" } });
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("a1", { targetServerId: "s2", acknowledge: { hostMounts: true, domainChanges: true }, repointDns: false, archiveRetainDays: 7, confirmName: "blog" }),
    );
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("mv1"));
    expect(onClose).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("The move has started.", "success");
  });

  it("options: repoint DNS and the archive retention are sent", async () => {
    show();
    await pickTargetAndContinue();
    fireEvent.click(await screen.findByLabelText("Repoint the DNS records Tugra manages for this app's domains"));
    fireEvent.change(screen.getByLabelText("Keep the old copy of the data for"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText("Type the app name to confirm"), { target: { value: "blog" } });
    fireEvent.click(screen.getByRole("button", { name: "Move app" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("a1", expect.objectContaining({ repointDns: true, archiveRetainDays: 30 })));
  });

  it("'Test link speed' re-runs the preflight with probeLink and shows the measured speed", async () => {
    show();
    await pickTargetAndContinue();
    preview.mockResolvedValueOnce(result({ plan: { ...result().plan, link: { ok: true, mbps: 312.5 } } }));
    fireEvent.click(await screen.findByRole("button", { name: "Test link speed" }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith("a1", { targetServerId: "s2", probeLink: true }));
    expect(await screen.findByText("Link between the servers: about 312.5 Mbit/s")).toBeTruthy();
  });

  it("a stale preflight (409 preflight_failed) returns to the review step with the hub's FRESH result", async () => {
    show();
    await pickTargetAndContinue();
    await screen.findByText("What will happen");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText("Type the app name to confirm"), { target: { value: "blog" } });
    const fresh = result({ ok: false, blockers: [{ code: "deploy_active", message: "" }] });
    start.mockRejectedValueOnce(new ApiError(409, "the move cannot start", "preflight_failed", { preflight: fresh }));
    fireEvent.click(screen.getByRole("button", { name: "Move app" }));
    const list = await screen.findByRole("list", { name: "Must be fixed first" });
    expect(within(list).getByText("A deployment is queued or running. Wait for it to finish.")).toBeTruthy();
  });

  it("a NEVER-deployed app (cheap path) says no downtime and hides the cold-move notice, copy size and retention", async () => {
    preview.mockResolvedValue(result({ plan: { ...result().plan, cheap: true, volumes: [], totalBytes: 0, estimatedParts: 0, estimatedDowntimeSec: { low: 0, high: 0 } } }));
    show();
    await pickTargetAndContinue();
    expect(await screen.findByText("No downtime: this app was never deployed, only its configuration moves.")).toBeTruthy();
    expect(screen.queryByText(/This is a COLD move/)).toBeNull();
    expect(screen.queryByLabelText("Keep the old copy of the data for")).toBeNull();
    expect(screen.queryByRole("button", { name: "Test link speed" })).toBeNull();
    expect(screen.getByText("This app has no data volumes: only its configuration moves.")).toBeTruthy();
  });

  it("an error from the preflight call is shown and the dialog stays on step 1", async () => {
    preview.mockRejectedValue(new Error("boom"));
    show();
    await pickTargetAndContinue();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "boom");
    expect(screen.getByLabelText("Target server")).toBeTruthy();
  });

  it("no other server in the team: says so instead of an empty select", async () => {
    vi.spyOn(api, "listServers").mockResolvedValue([SERVERS[0]]);
    show();
    expect(await screen.findByText("There is no other server in this team to move the app to.")).toBeTruthy();
    expect(screen.queryByLabelText("Target server")).toBeNull();
  });
});
