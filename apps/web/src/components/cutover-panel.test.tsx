import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { CutoverPanel } from "./cutover-panel";
import { api, ApiError, type CutoverEntryView, type CutoverFlipPlan, type CutoverView } from "../lib/api";
import { isRunning, targetHostnames, isFlippable, hasHttp01Gap, flippedSourceApps, CUTOVER_POLL_MS } from "../lib/cutover";

afterEach(cleanup);

const HASH = "ab".repeat(32);

const entry = (over: Partial<CutoverEntryView>): CutoverEntryView => ({
  id: over.hostname ?? "e",
  applicationId: "app1",
  appName: "web-app",
  hostname: "example.com",
  role: "primary",
  state: "PLANNED",
  blockReason: null,
  dnsMode: "cloudflare",
  challenge: "dns01",
  certState: "unknown",
  certIssuer: null,
  certNotAfter: null,
  certError: null,
  dnsObserved: "source",
  proxied: null,
  viaWildcard: false,
  sslMode: null,
  currentTtl: 300,
  targetTtl: 60,
  ttlWaitUntil: null,
  stateful: false,
  needsDeploy: false,
  warnings: [],
  precheckAt: null,
  flippedAt: null,
  verifiedAt: null,
  finalizedAt: null,
  lastError: null,
  sourceName: "web-app-src",
  ...over,
});

const view = (entries: CutoverEntryView[], over: Partial<CutoverView> = {}): CutoverView => ({
  opId: "op1",
  run: null,
  summary: { total: entries.length, planned: 0, certReady: 0, ready: 0, switched: 0, verified: 0, blocked: 0, conflict: 0, failed: 0, excluded: 0 },
  servers: [{ serverId: "s1", name: "Server A", publicIp: "203.0.113.7", publicIpv6: null, proxyBind: "public", acmeEmailOk: true, dnsReady: true, dnsProvider: "cloudflare", dnsCredentialId: "c1", coverage: "unverified", warnings: [] }],
  entries,
  certs: { staged: 0, applied: 0 },
  ...over,
});

const plan = (hostnames: string[], warnings: string[] = []): CutoverFlipPlan => ({
  opId: "op1",
  planHash: HASH,
  entries: hostnames.map((h) => ({
    hostname: h,
    appName: "web-app",
    challenge: "dns01",
    records: [{ type: "A", name: h, action: "update", old: { content: "198.51.100.1", ttl: 300, proxied: false }, new: { content: "203.0.113.7", ttl: 60, proxied: false } }],
    warnings,
  })),
  rate: { batchSize: 5, intervalSec: 30, estimatedSeconds: 90 },
  blocked: [],
  copyPaste: [],
  sourceStop: [{ appName: "web-app", sourceName: "web-app-src", hostnames }],
});

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("CutoverPanel", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listDnsCredentials").mockResolvedValue([{ id: "c1", name: "CF main", teamId: "t1", provider: "cloudflare", cfAccountId: null, lastVerifiedAt: null, createdAt: "", canWrite: true }]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("offers setup when the cutover was never initialised", async () => {
    vi.spyOn(api, "getCutover").mockRejectedValue(new ApiError(404, "not found"));
    const init = vi.spyOn(api, "cutoverInit").mockResolvedValue(view([entry({})]));
    wrap(<CutoverPanel opId="op1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up cutover" }));
    await waitFor(() => expect(init).toHaveBeenCalledWith("op1", {}));
    await screen.findByText("example.com");
  });

  it("renders the preflight strip and a row per host with state, DNS, certificate and TTL", async () => {
    vi.spyOn(api, "getCutover").mockResolvedValue(
      view([
        entry({ hostname: "a.example.com", state: "READY", dnsObserved: "source", certState: "ready", certIssuer: "Let's Encrypt", certNotAfter: "2027-01-01T00:00:00.000Z" }),
        entry({ hostname: "b.example.com", state: "BLOCKED", blockReason: "caa-blocks-letsencrypt", dnsObserved: "tunnel", warnings: ["stateful"] }),
        entry({ hostname: "c.example.com", state: "VERIFIED", dnsObserved: "target", flippedAt: "2026-11-01T00:00:00.000Z", needsDeploy: true }),
      ]),
    );
    wrap(<CutoverPanel opId="op1" />);
    await screen.findByText("a.example.com");
    // preflight
    expect(screen.getByText("Server A")).toBeTruthy();
    expect(screen.getByText("Credential coverage")).toBeTruthy();
    expect(screen.getByText("Unverified")).toBeTruthy();
    // table
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(expect.arrayContaining(["Host", "App", "Role", "DNS", "Certificate", "TTL", "Precheck", "State", "Actions"]));
    expect(within(table).getAllByText("Ready").length).toBe(2); // the READY state badge + the ready certificate
    expect(within(table).getByText("Blocked")).toBeTruthy();
    expect(within(table).getByText("Verified")).toBeTruthy();
    expect(within(table).getByText("Let's Encrypt")).toBeTruthy();
    expect(within(table).getByText("A CAA record blocks Let's Encrypt")).toBeTruthy();
    expect(within(table).getByText("Tunnel")).toBeTruthy();
    expect(within(table).getAllByText("300s → 60s").length).toBe(3);
    expect(screen.getByText(/need a redeploy/)).toBeTruthy();
    // the printed source-stop steps appear once a host has been flipped
    expect(screen.getByText("Stop the source app")).toBeTruthy();
    expect(screen.getByText(/stale DNS|still resolve the old DNS/i)).toBeTruthy();
  });

  it("flip dialog shows the record diff and gates the button on the typed id and acknowledgements", async () => {
    vi.spyOn(api, "getCutover").mockResolvedValue(
      view([
        entry({ hostname: "a.example.com", state: "READY", stateful: true, challenge: "http01", certState: "pending" }),
      ]),
    );
    const planSpy = vi.spyOn(api, "getCutoverFlipPlan").mockResolvedValue(plan(["a.example.com"], ["stateful", "http01-gap"]));
    const flip = vi.spyOn(api, "cutoverFlip").mockResolvedValue({ runId: "r1", planHash: HASH, queued: true });
    wrap(<CutoverPanel opId="op1" />);
    await screen.findByText("a.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Plan flip" }));

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/198\.51\.100\.1/);
    expect(within(dialog).getByText(/203\.0\.113\.7/)).toBeTruthy();
    expect(planSpy).toHaveBeenCalledWith("op1", { hostnames: ["a.example.com"], targetTtl: 60, keepProxied: true });
    expect(within(dialog).getByText(/never applied to stateful apps/)).toBeTruthy();

    const flipBtn = within(dialog).getByRole("button", { name: "Flip DNS" });
    expect(flipBtn).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Type op1 to confirm"), { target: { value: "op1" } });
    expect(flipBtn).toBeDisabled(); // typed, but the two required acknowledgements are not ticked
    fireEvent.click(within(dialog).getByLabelText(/some of these apps hold state/));
    expect(flipBtn).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/no certificate yet/));
    expect(flipBtn).toBeEnabled();

    // an out-of-range batch size disables it again
    fireEvent.change(within(dialog).getByLabelText(/^Batch size/), { target: { value: "99" } });
    expect(flipBtn).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^Batch size/), { target: { value: "3" } });
    expect(flipBtn).toBeEnabled();

    fireEvent.click(flipBtn);
    await waitFor(() => expect(flip).toHaveBeenCalled());
    expect(flip.mock.calls[0][1]).toMatchObject({
      confirmToken: HASH,
      hostnames: ["a.example.com"],
      batchSize: 3,
      intervalSec: 30,
      targetTtl: 60,
      stopOnFail: true,
      autoRevert: false,
      keepProxied: true,
      acceptDataRisk: true,
      acceptHttp01Gap: true,
    });
  });

  it("does not ask for the data-risk or http01 acknowledgements when nothing needs them", async () => {
    vi.spyOn(api, "getCutover").mockResolvedValue(view([entry({ hostname: "a.example.com", state: "READY", certState: "ready" })]));
    vi.spyOn(api, "getCutoverFlipPlan").mockResolvedValue(plan(["a.example.com"]));
    wrap(<CutoverPanel opId="op1" />);
    await screen.findByText("a.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Plan flip" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/198\.51\.100\.1/);
    expect(within(dialog).queryByLabelText(/some of these apps hold state/)).toBeNull();
    expect(within(dialog).queryByLabelText(/no certificate yet/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Type op1 to confirm"), { target: { value: "op1" } });
    expect(within(dialog).getByRole("button", { name: "Flip DNS" })).toBeEnabled();
  });

  it("revert dialog requires the data-loss acknowledgement and sends acknowledgeDataLoss", async () => {
    const v = view([entry({ hostname: "a.example.com", state: "SWITCHED", flippedAt: "2026-11-01T00:00:00.000Z" })]);
    vi.spyOn(api, "getCutover").mockResolvedValue(v);
    const revert = vi.spyOn(api, "cutoverRevert").mockResolvedValue(v);
    wrap(<CutoverPanel opId="op1" />);
    await screen.findByText("a.example.com");
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Revert" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/cannot restore data written on Tugra/)).toBeTruthy();
    const go = within(dialog).getByRole("button", { name: "Revert" });
    expect(go).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/data written on Tugra after the flip is not restored/));
    expect(go).toBeEnabled();
    fireEvent.click(within(dialog).getByLabelText(/Force the revert/));
    fireEvent.click(go);
    await waitFor(() => expect(revert).toHaveBeenCalledWith("op1", { hostnames: ["a.example.com"], force: true, acknowledgeDataLoss: true }));
  });

  it("polls the view every 3 s while a flip run is running", async () => {
    expect(CUTOVER_POLL_MS).toBe(3000);
    const get = vi.spyOn(api, "getCutover").mockResolvedValue(
      view([entry({ hostname: "a.example.com", state: "SWITCHING" })], { run: { id: "r1", status: "running", batchesDone: 0, total: 1, startedAt: "2026-11-01T00:00:00.000Z", heartbeatAt: "2026-11-01T00:00:00.000Z", lastError: null } }),
    );
    wrap(<CutoverPanel opId="op1" />);
    await screen.findByText("a.example.com");
    expect(screen.getByText("Flip running")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 6000 });
  }, 12000);

  it("does not poll when no run is active", async () => {
    const get = vi.spyOn(api, "getCutover").mockResolvedValue(view([entry({ hostname: "a.example.com", state: "READY" })]));
    wrap(<CutoverPanel opId="op1" />);
    await screen.findByText("a.example.com");
    await new Promise((r) => setTimeout(r, 200));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("fix-counterpart sends the chosen direction", async () => {
    vi.spyOn(api, "getCutover").mockResolvedValue(view([entry({ hostname: "www.example.com", state: "BLOCKED", blockReason: "counterpart-not-served" })]));
    const fix = vi.spyOn(api, "cutoverFixCounterpart").mockResolvedValue(view([]));
    wrap(<CutoverPanel opId="op1" />);
    await screen.findByText("www.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Serve the root domain of www.example.com too" }));
    await waitFor(() => expect(fix).toHaveBeenCalledWith("op1", { applicationId: "app1", direction: "root" }));
  });
});

describe("cutover view helpers", () => {
  const e = (o: Partial<CutoverEntryView>) => entry(o);
  it("targets the selection, or every eligible host when nothing is selected", () => {
    const list = [e({ hostname: "a", state: "READY" }), e({ hostname: "b", state: "PLANNED" }), e({ hostname: "c", state: "READY" })];
    expect(targetHostnames(list, new Set(), isFlippable)).toEqual(["a", "c"]);
    expect(targetHostnames(list, new Set(["c", "b"]), isFlippable)).toEqual(["c"]);
  });
  it("detects http01 gaps, running runs and flipped source apps", () => {
    expect(hasHttp01Gap(e({ challenge: "http01", certState: "pending" }))).toBe(true);
    expect(hasHttp01Gap(e({ challenge: "http01", certState: "ready" }))).toBe(false);
    expect(hasHttp01Gap(e({ challenge: "dns01", certState: "pending" }))).toBe(false);
    expect(isRunning(view([]))).toBe(false);
    expect(flippedSourceApps([e({ hostname: "a", flippedAt: "x", state: "SWITCHED" }), e({ hostname: "b", flippedAt: "x", state: "ROLLED_BACK" })])).toEqual([
      { applicationId: "app1", appName: "web-app", sourceName: "web-app-src", hostnames: ["a"] },
    ]);
  });
});
