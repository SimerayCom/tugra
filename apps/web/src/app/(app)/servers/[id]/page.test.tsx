import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor, act } from "@testing-library/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ConfirmProvider } from "../../../../components/confirm";
import { emitToast, subscribeToast } from "../../../../lib/toast-bus";
import type { ServerView } from "../../../../lib/types";

// Next navigation: the tab lives in ?tab=, which each test sets via `nav.tab`.
const nav = vi.hoisted(() => ({ tab: "overview" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "s1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/servers/s1",
  useSearchParams: () => new URLSearchParams(nav.tab === "overview" ? "" : `tab=${nav.tab}`),
}));

// Every api method not stubbed by a test stays pending forever, so unrelated cards on the page just idle.
const stubs = vi.hoisted(() => ({ fns: {} as Record<string, (...a: unknown[]) => unknown> }));
vi.mock("../../../../lib/api", () => ({
  api: new Proxy({}, { get: (_t, k: string) => stubs.fns[k] ?? (() => new Promise(() => {})) }),
}));

import ServerDetailPage from "./page";
import { patchTiming } from "../../../../lib/patching";


const server = (o: Partial<ServerView> = {}): ServerView =>
  ({
    id: "s1", name: "box", status: "ONLINE", teamId: "t1", clusterId: null, clusterName: null, hostname: null, publicIp: "1.2.3.4",
    publicIpv6: null, ipSource: "observed", wildcardDomain: null, magicSuffix: null, certMode: "http", dnsProvider: null,
    customCertResolver: null, hasDnsCreds: false, os: null, osVersion: null, arch: null, kernel: null, agentVersion: "0.1.0",
    cpuCores: null, memTotalBytes: null, uptimeSeconds: null, cleanupEnabled: false, cleanupIntervalHours: null, cleanupCron: null,
    cleanupThresholdPct: null, cleanupVolumes: false, description: null, timezone: null, lastCleanupAt: null, lastSeenAt: null,
    createdAt: "", seal: null, tags: [], capabilities: [], isLocal: false, proxyBind: "public", trafficAnalytics: false, provider: null,
    providerServerId: null, providerManualLink: false, canWrite: true, canOps: true, ...o,
  }) as unknown as ServerView;

let qc: QueryClient;
let toasts: { message: string; type: string }[];
let unsub: () => void;

function mount() {
  // Same global success/error toasting as lib/providers.tsx, so meta.successMessage saves are observable.
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    mutationCache: new MutationCache({
      onError: (e) => emitToast(e instanceof Error ? e.message : "err", "error"),
      onSuccess: (_d, _v, _c, m) => {
        const msg = m.meta?.successMessage;
        if (typeof msg === "string" && msg) emitToast(msg, "success");
      },
    }),
  });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <ServerDetailPage />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const confirmDialog = async () => fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
const toastTexts = () => toasts.map((t) => t.message);

const timing0 = { ...patchTiming };
beforeEach(() => {
  Object.assign(patchTiming, timing0);
  toasts = [];
  unsub = subscribeToast((t) => toasts.push(t));
  stubs.fns = { getServer: async () => server() };
  nav.tab = "overview";
});
afterEach(() => {
  unsub();
  cleanup();
});

describe("server detail feedback", () => {
  it("proxy restart toasts when it finishes", async () => {
    nav.tab = "maintenance";
    stubs.fns.getProxyStatus = async () => ({ status: "running" });
    stubs.fns.restartProxy = async () => ({ status: "running" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(toastTexts()).toContain("Proxy restarted"));
  });

  it("proxy refresh icon is labelled correctly and spins while the status refetches", async () => {
    nav.tab = "maintenance";
    stubs.fns.getProxyStatus = () => new Promise(() => {}); // still fetching
    mount();
    const btn = await screen.findByRole("button", { name: "Refresh proxy status" });
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("button", { name: "View logs" })).toHaveLength(1);
  });

  it("network settings save toasts Saved", async () => {
    nav.tab = "maintenance";
    stubs.fns.setServerNetwork = async () => ({ ok: true });
    mount();
    const card = (await waitFor(() => {
      const el = document.getElementById("wildcard");
      expect(el).not.toBeNull();
      return el;
    })) as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toasts).toContainEqual({ message: "Saved", type: "success" }));
  });

  it("the Maintenance tab has the Reboot card, typed to this server's name", async () => {
    nav.tab = "maintenance";
    stubs.fns.getServerReboot = async () => ({ active: null, last: null });
    stubs.fns.getServerRebootPreview = async () => ({ containers: 4, domains: 2, hostsHub: false, agentOnline: true });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Reboot now" }));
    expect(await screen.findByLabelText(/Type the server name box/)).toBeInTheDocument();
  });

  it("proxy dynamic config save toasts saved and applied", async () => {
    nav.tab = "maintenance";
    stubs.fns.listProxyDynamicConfigs = async () => ({ configs: [{ name: "rl", content: "a: 1" }] });
    stubs.fns.putProxyDynamicConfig = async () => ({ ok: true });
    mount();
    const ta = await screen.findByLabelText("user-rl.yml");
    fireEvent.change(ta, { target: { value: "a: 2" } });
    fireEvent.click(within(ta.parentElement as HTMLElement).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastTexts()).toContain("Configuration saved and applied"));
  });

  it("tunnel setup toasts that it is connecting", async () => {
    nav.tab = "maintenance";
    stubs.fns.getTunnelStatus = async () => ({ configured: false, status: null });
    stubs.fns.setupTunnel = async () => ({ configured: true, status: "connecting" });
    mount();
    fireEvent.change(await screen.findByLabelText(/Cloudflare API token/), { target: { value: "tok" } });
    fireEvent.change(screen.getByLabelText(/Cloudflare account ID/), { target: { value: "acc" } });
    fireEvent.change(screen.getByLabelText(/Zone \(your Cloudflare domain\)/), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Cloudflare" }));
    await waitFor(() => expect(toastTexts()).toContain("Tunnel created — connecting to Cloudflare…"));
  });

  it("tunnel disconnect shows progress then toasts", async () => {
    nav.tab = "maintenance";
    let release: (v: unknown) => void = () => {};
    stubs.fns.getTunnelStatus = async () => ({ configured: true, status: "connected", zoneName: "example.com", wildcardDomain: "apps.example.com", lastError: null });
    stubs.fns.teardownTunnel = () => new Promise((r) => { release = r; });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect tunnel" }));
    await confirmDialog();
    const busy = await screen.findByRole("button", { name: "Disconnecting…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    await act(async () => release({ ok: true }));
    await waitFor(() => expect(toastTexts()).toContain("Tunnel disconnected"));
  });

  it("agent update shows a restarting state, then toasts the new version", async () => {
    nav.tab = "updates";
    let version = "0.1.0";
    stubs.fns.getServer = async () => server({ agentVersion: version });
    stubs.fns.updateAgent = async () => ({ status: "ok", total: 1, sent: 1, offline: 0, skipped: 0, results: [{ serverId: "s1", status: "sent" }] });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Update agent" }));
    await confirmDialog();
    expect(await screen.findByRole("button", { name: "Restarting…" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("restarting on the new version");
    expect(toastTexts()).not.toContain("Agent updated to 0.2.0");
    version = "0.2.0";
    await act(async () => { await qc.invalidateQueries({ queryKey: ["server", "s1"] }); });
    await waitFor(() => expect(toastTexts()).toContain("Agent updated to 0.2.0"));
    expect(await screen.findByRole("button", { name: "Update agent" })).toBeEnabled();
  });

  const pkgInfo = (o: Record<string, unknown> = {}) => ({
    supported: true, manager: "apt", checkFailed: false, rebootRequired: false, count: 1, dpkgInterrupted: null, applyRunning: false,
    packages: [{ name: "openssl", current: "1", candidate: "2" }], ...o,
  });

  const pkgs = (...names: string[]) => names.map((name) => ({ name, current: "1", candidate: "2" }));
  const err = (status: number, message: string) => Object.assign(new Error(message), { status });
  const clickCheck = async () => fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));

  it("update all re-checks by itself, clears the applied rows and toasts what changed", async () => {
    nav.tab = "updates";
    let calls = 0;
    stubs.fns.checkUpdates = async () => (++calls === 1 ? pkgInfo({ count: 2, packages: pkgs("docker-ce", "openssl") }) : pkgInfo({ count: 0, packages: [], rebootRequired: true }));
    stubs.fns.upgradeAll = async () => ({ output: "done", exitCode: 0 });
    mount();
    await clickCheck();
    expect(await screen.findByText("docker-ce")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toastTexts()).toContain("2 package(s) updated — the server is up to date."));
    await waitFor(() => expect(toastTexts()).toContain("Updates applied — a reboot is required to finish them."));
    expect(calls).toBe(2); // no manual second click
    expect(screen.queryByText("docker-ce")).toBeNull();
    expect(screen.getByText("Your server is up to date.")).toBeInTheDocument();
    expect(screen.getByText("A reboot is required to finish applying updates.")).toBeInTheDocument();
  });

  it("the reboot-required banner links to the Reboot card (the page never reboots anything itself)", async () => {
    nav.tab = "updates";
    stubs.fns.checkUpdates = async () => pkgInfo({ count: 0, packages: [], rebootRequired: true });
    const reboot = vi.fn();
    stubs.fns.requestServerReboot = reboot;
    mount();
    await clickCheck();
    expect(await screen.findByText("A reboot is required to finish applying updates.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reboot this server…" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reboot this server…" }));
    expect(reboot).not.toHaveBeenCalled();
  });

  it("a single-package update reports the counts and keeps the remaining rows", async () => {
    nav.tab = "updates";
    let calls = 0;
    stubs.fns.checkUpdates = async () => (++calls === 1 ? pkgInfo({ count: 2, packages: pkgs("curl", "openssl") }) : pkgInfo({ count: 1, packages: pkgs("openssl") }));
    stubs.fns.upgradeOne = async () => ({ output: "ok", exitCode: 0 });
    mount();
    await clickCheck();
    fireEvent.click((await screen.findAllByRole("button", { name: "Update" }))[0]);
    await waitFor(() => expect(toastTexts()).toContain("curl updated — 1 package(s) still pending."));
    expect(screen.queryByText("curl")).toBeNull();
    expect(screen.getByText("openssl")).toBeInTheDocument();
  });

  it("warns when an update leaves everything pending", async () => {
    nav.tab = "updates";
    stubs.fns.checkUpdates = async () => pkgInfo({ count: 1, packages: pkgs("linux-image") });
    stubs.fns.upgradeAll = async () => ({ output: "kept back", exitCode: 0 });
    mount();
    await clickCheck();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toasts.some((x) => x.type === "error" && /No packages were updated — 1 still pending/.test(x.message))).toBe(true));
  });

  it("when the update restarts Docker the card waits for the agent and re-checks instead of showing stale rows", async () => {
    nav.tab = "updates";
    patchTiming.intervalMs = 5;
    let phase: "before" | "down" | "up" = "before";
    let downChecks = 0;
    stubs.fns.checkUpdates = async () => {
      if (phase === "before") return pkgInfo({ count: 2, packages: pkgs("docker-ce", "containerd.io") });
      if (phase === "down" && ++downChecks < 3) throw err(503, "The agent is offline — try again once it reconnects.");
      return pkgInfo({ count: 0, packages: [] });
    };
    stubs.fns.upgradeAll = async () => { phase = "down"; throw err(503, "agent disconnected"); };
    mount();
    await clickCheck();
    expect(await screen.findByText("docker-ce")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    expect(await screen.findByText(/reconnecting/)).toBeInTheDocument();
    expect(screen.queryByText("docker-ce")).toBeNull(); // stale rows are not shown while waiting
    await waitFor(() => expect(toastTexts()).toContain("2 package(s) updated. The agent restarted during the update and is back online — the server is up to date."));
    expect(screen.getByText("Your server is up to date.")).toBeInTheDocument();
    expect(downChecks).toBe(3);
    expect(toasts.filter((x) => x.type === "error")).toHaveLength(0);
  });

  it("hides the stale list and says so when the re-check never gets an answer", async () => {
    nav.tab = "updates";
    patchTiming.intervalMs = 5;
    patchTiming.deadlineMs = 40;
    let after = false;
    stubs.fns.checkUpdates = async () => {
      if (!after) return pkgInfo({ rebootRequired: true });
      throw err(503, "offline");
    };
    stubs.fns.upgradeAll = async () => { after = true; return { output: "done", exitCode: 0 }; };
    mount();
    await clickCheck();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toasts.some((x) => x.type === "error" && /could not be re-checked/.test(x.message))).toBe(true));
    expect(screen.queryByText("openssl")).toBeNull();
    expect(screen.queryByText("A reboot is required to finish applying updates.")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("press “Check for updates”");
    expect(toastTexts()).not.toContain("Updates applied");
  });

  it("a refused apply (4xx) toasts the error and leaves the list alone", async () => {
    nav.tab = "updates";
    let calls = 0;
    stubs.fns.checkUpdates = async () => { calls++; return pkgInfo(); };
    stubs.fns.upgradeAll = async () => { throw err(403, "no permission"); };
    mount();
    await clickCheck();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toasts).toContainEqual({ message: "no permission", type: "error" }));
    expect(calls).toBe(1);
    expect(screen.getByText("openssl")).toBeInTheDocument();
  });

  it("a non-zero apply exit toasts a failure with counts instead of success", async () => {
    nav.tab = "updates";
    let calls = 0;
    stubs.fns.checkUpdates = async () => (++calls === 1 ? pkgInfo({ count: 2, packages: pkgs("a", "b") }) : pkgInfo({ count: 1, packages: pkgs("b") }));
    stubs.fns.upgradeAll = async () => ({ output: "E: broken", exitCode: 100 });
    mount();
    await clickCheck();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toasts.some((x) => x.type === "error" && /did not finish cleanly — 1 package\(s\) updated, 1 still pending/.test(x.message))).toBe(true));
    expect(toastTexts()).not.toContain("Updates applied");
  });

  it("the per-package Update button shows loading on its own row", async () => {
    nav.tab = "updates";
    stubs.fns.checkUpdates = async () => pkgInfo();
    stubs.fns.upgradeOne = () => new Promise(() => {});
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    const busy = await screen.findByRole("button", { name: "Updating…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
  });
});

describe("server overview: scan and Seal", () => {
  it("explains Seal with a one-line tooltip wired to its button", async () => {
    stubs.fns.getServer = async () => server({ seal: "abc" });
    mount();
    const btn = await screen.findByRole("button", { name: "About Seal" });
    const tip = screen.getByRole("tooltip");
    expect(btn.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.textContent).toMatch(/identity key/);
  });

  it("shows the scan card on the overview and sends a suggested adoption to the Maintenance tab's adopt card", async () => {
    stubs.fns.getServerScan = async () => ({
      report: {
        v: 1, scannedAt: new Date().toISOString(), host: { status: "ok", reason: null },
        docker: { available: true, total: 1, running: 1, tugra: 0, truncated: false },
        software: [{ id: "redis", label: "Redis", kind: "database", logo: "redis", count: 1, containers: ["cache"] }],
        containers: [{ name: "cache", image: "redis:7", state: "running", project: null, service: null, software: "redis", managedBy: null, ports: [], adoptable: true }],
        composeProjects: [], pm2: [], sites: [], services: [], ports: [],
      },
    });
    mount();
    expect(await screen.findByText("What runs on this server")).toBeInTheDocument();
    expect(await screen.findByText("1 container can be adopted as a Tugra app.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan again" })).toBeInTheDocument();
  });
});

describe("server patching: Ubuntu phased updates", () => {
  const info = (o: Record<string, unknown> = {}) => ({
    supported: true, manager: "apt", checkFailed: false, rebootRequired: false, count: 0, dpkgInterrupted: null, applyRunning: false,
    packages: [], phased: [{ name: "snapd", current: "2.76.3", candidate: "2.78" }], ...o,
  });
  const clickCheck = async () => fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));

  it("shows a phased package in its own muted section, not in the count, with the explanation", async () => {
    nav.tab = "updates";
    stubs.fns.checkUpdates = async () => info();
    mount();
    await clickCheck();
    const section = await screen.findByTestId("phased-updates");
    expect(within(section).getByText("snapd")).toBeInTheDocument();
    expect(section).toHaveTextContent("Ubuntu is rolling this update out gradually; it installs automatically when this server's turn comes.");
    expect(within(section).getByRole("button", { name: "Install now" })).toBeEnabled();
    expect(screen.getByText("Your server is up to date.")).toBeInTheDocument();
    expect(screen.queryByText(/can be upgraded/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Update all" })).toBeNull();
  });

  it("no phased section when nothing is phased (also for a hub that does not send the field)", async () => {
    nav.tab = "updates";
    stubs.fns.checkUpdates = async () => info({ phased: undefined });
    mount();
    await clickCheck();
    expect(await screen.findByText("Your server is up to date.")).toBeInTheDocument();
    expect(screen.queryByTestId("phased-updates")).toBeNull();
  });

  it("Install now forces just that package through upgradePhased; Update all and Update never do", async () => {
    nav.tab = "updates";
    let calls = 0;
    const upgradePhased = vi.fn(async () => ({ output: "ok", exitCode: 0 }));
    const upgradeOne = vi.fn(async () => ({ output: "", exitCode: 0 }));
    const upgradeAll = vi.fn(async () => ({ output: "", exitCode: 0 }));
    stubs.fns.checkUpdates = async () => (++calls === 1 ? info({ count: 1, packages: [{ name: "vim", current: "1", candidate: "2" }] }) : info({ count: 1, packages: [{ name: "vim", current: "1", candidate: "2" }], phased: [] }));
    Object.assign(stubs.fns, { upgradePhased, upgradeOne, upgradeAll });
    mount();
    await clickCheck();
    fireEvent.click(await within(await screen.findByTestId("phased-updates")).findByRole("button", { name: "Install now" }));
    await waitFor(() => expect(toastTexts()).toContain("snapd updated — 1 package(s) still pending."));
    expect(upgradePhased).toHaveBeenCalledWith("s1", "snapd");
    expect(upgradeOne).not.toHaveBeenCalled();
    expect(upgradeAll).not.toHaveBeenCalled();
    expect(screen.queryByTestId("phased-updates")).toBeNull();
    expect(screen.getByText("vim")).toBeInTheDocument(); // the normal list is untouched
  });

  it("the normal update buttons never claim a phased package", async () => {
    nav.tab = "updates";
    const upgradePhased = vi.fn(async () => ({ output: "", exitCode: 0 }));
    const upgradeAll = vi.fn(async () => ({ output: "", exitCode: 0 }));
    stubs.fns.checkUpdates = async () => info({ count: 1, packages: [{ name: "vim", current: "1", candidate: "2" }] });
    Object.assign(stubs.fns, { upgradePhased, upgradeAll });
    mount();
    await clickCheck();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(upgradeAll).toHaveBeenCalledTimes(1));
    expect(upgradePhased).not.toHaveBeenCalled();
  });

  it("an update that apt still defers for phasing says so instead of 'held back'", async () => {
    nav.tab = "updates";
    let calls = 0;
    const pkg = { name: "snapd", current: "2.76.3", candidate: "2.78" };
    stubs.fns.checkUpdates = async () => (++calls === 1 ? info({ count: 1, packages: [pkg], phased: [] }) : info({ count: 0, packages: [], phased: [pkg] }));
    stubs.fns.upgradeAll = async () => ({ output: "The following upgrades have been deferred due to phasing:\n  snapd", exitCode: 0 });
    mount();
    await clickCheck();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toasts.some((x) => /deferred by Ubuntu's phased rollout/.test(x.message))).toBe(true));
    expect(toasts.some((x) => /held back/.test(x.message))).toBe(false);
    expect(await screen.findByTestId("phased-updates")).toBeInTheDocument();
  });

  it("the generic 'held back' hint stays for a package that is still pending and not phased", async () => {
    nav.tab = "updates";
    const pkg = { name: "linux-image", current: "1", candidate: "2" };
    stubs.fns.checkUpdates = async () => info({ count: 1, packages: [pkg], phased: [] });
    stubs.fns.upgradeAll = async () => ({ output: "kept back", exitCode: 0 });
    mount();
    await clickCheck();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toasts.some((x) => x.type === "error" && /held back/.test(x.message))).toBe(true));
  });
});

describe("server patching: interrupted dpkg and a still-running update", () => {
  const info = (o: Record<string, unknown> = {}) => ({
    supported: true, manager: "apt", checkFailed: false, rebootRequired: false, count: 1, dpkgInterrupted: null, applyRunning: false,
    packages: [{ name: "openssl", current: "1", candidate: "2" }], ...o,
  });
  const brokenEngine = { packages: [{ name: "docker-ce", state: "half-configured" }, { name: "containerd.io", state: "unpacked" }], containerEngine: true };
  const clickCheck = async () => fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));

  it("a check shows the half-configured engine as its own warning with the remedy — and only checks", async () => {
    nav.tab = "updates";
    const upgradeAll = vi.fn(async () => ({ output: "", exitCode: 0 }));
    stubs.fns.checkUpdates = async () => info({ dpkgInterrupted: brokenEngine });
    stubs.fns.upgradeAll = upgradeAll;
    mount();
    await clickCheck();
    const banner = await screen.findByTestId("dpkg-interrupted");
    expect(banner).toHaveTextContent("docker-ce (half-configured), containerd.io (unpacked)");
    expect(banner).toHaveTextContent("Checking never repairs this");
    expect(banner).toHaveTextContent("container engine");
    expect(banner).toHaveTextContent("restarts Docker");
    expect(banner).toHaveTextContent("“Update all”");
    expect(upgradeAll).not.toHaveBeenCalled();
  });

  it("a non-engine interrupted package shows the remedy without the Docker-restart warning, and updating needs no extra confirmation", async () => {
    nav.tab = "updates";
    const upgradeAll = vi.fn(async () => ({ output: "", exitCode: 0 }));
    let calls = 0;
    stubs.fns.checkUpdates = async () => (++calls === 1 ? info({ dpkgInterrupted: { packages: [{ name: "man-db", state: "triggers-pending" }], containerEngine: false } }) : info({ count: 0, packages: [] }));
    stubs.fns.upgradeAll = upgradeAll;
    mount();
    await clickCheck();
    const banner = await screen.findByTestId("dpkg-interrupted");
    expect(banner).toHaveTextContent("man-db (triggers-pending)");
    expect(banner).not.toHaveTextContent("restarts Docker");
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(upgradeAll).toHaveBeenCalledTimes(1));
  });

  it("updating with a half-configured engine asks first: cancel runs nothing, confirm runs the update", async () => {
    nav.tab = "updates";
    const upgradeAll = vi.fn(async () => ({ output: "", exitCode: 0 }));
    let calls = 0;
    stubs.fns.checkUpdates = async () => (++calls === 1 ? info({ dpkgInterrupted: brokenEngine }) : info({ count: 0, packages: [] }));
    stubs.fns.upgradeAll = upgradeAll;
    mount();
    await clickCheck();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("docker-ce, containerd.io");
    expect(dialog).toHaveTextContent("restarts Docker");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(upgradeAll).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update and restart Docker" }));
    await waitFor(() => expect(upgradeAll).toHaveBeenCalledTimes(1));
  });

  it("nothing to upgrade but dpkg interrupted is NOT 'up to date': it offers to finish the update", async () => {
    nav.tab = "updates";
    stubs.fns.checkUpdates = async () => info({ count: 0, packages: [], dpkgInterrupted: { packages: [{ name: "vim", state: "half-configured" }], containerEngine: false } });
    mount();
    await clickCheck();
    expect(await screen.findByRole("button", { name: "Finish interrupted update" })).toBeEnabled();
    expect(screen.queryByText("Your server is up to date.")).toBeNull();
  });

  it("after an update the card keeps waiting while the host still reports the update running, then shows the result", async () => {
    nav.tab = "updates";
    patchTiming.intervalMs = 5;
    let phase: "before" | "running" | "done" = "before";
    let runningChecks = 0;
    let seen = false; // the host keeps reporting "running" until the test has seen the waiting state (no race under load)
    stubs.fns.checkUpdates = async () => {
      if (phase === "before") return info();
      if (phase === "running" && (!seen || runningChecks < 2)) { runningChecks++; return info({ applyRunning: true }); }
      return info({ count: 0, packages: [] });
    };
    stubs.fns.upgradeAll = async () => { phase = "running"; throw Object.assign(new Error("Bad Gateway"), { status: 502 }); }; // the hub went down with Docker
    mount();
    await clickCheck();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    expect(await screen.findByText(/still running on this server/)).toBeInTheDocument();
    seen = true;
    await waitFor(() => expect(screen.getByText("Your server is up to date.")).toBeInTheDocument());
    expect(runningChecks).toBeGreaterThanOrEqual(2);
    expect(toasts.filter((x) => x.type === "error")).toHaveLength(0);
  });

  it("a check that finds an update running says so and disables the update buttons", async () => {
    nav.tab = "updates";
    stubs.fns.checkUpdates = async () => info({ applyRunning: true });
    mount();
    await clickCheck();
    expect(await screen.findByText(/update is running on this server right now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
  });
});

describe("delete server: destroying the VM is offered only for a VM Tugra provisioned", () => {
  const open = async () => {
    nav.tab = "maintenance";
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Delete server" }));
    await screen.findByRole("dialog");
  };

  it("a provisioned VM offers 'Also destroy the VM'", async () => {
    stubs.fns.getServer = async () => server({ provider: "hetzner", providerServerId: "42" });
    await open();
    expect(screen.getByText(/Also destroy the VM at hetzner/)).toBeInTheDocument();
  });

  it("a hand-linked VM (out-of-band only) never offers it", async () => {
    stubs.fns.getServer = async () => server({ provider: "hetzner", providerServerId: "42", providerManualLink: true });
    await open();
    expect(screen.queryByText(/Also destroy the VM/)).toBeNull();
  });
});

describe("docker cleanup card (default-on, what it does and does not delete)", () => {
  const stateText = async () => (await screen.findByTestId("cleanup-state")).textContent ?? "";

  it("default server: shows ON with the daily schedule and the disk trigger", async () => {
    nav.tab = "maintenance";
    stubs.fns.getServer = async () => server({ cleanupEnabled: true, cleanupCron: "0 3 * * *", cleanupThresholdPct: 80 });
    mount();
    const text = await stateText();
    expect(text).toContain("Automatic cleanup is on");
    expect(text).toContain("Runs on schedule “0 3 * * *”");
    expect(text).toContain("whenever disk usage reaches 80% (at most once an hour)");
    expect(text).toContain("Not run yet");
  });

  it("an interval-only schedule and a missing threshold are described honestly", async () => {
    nav.tab = "maintenance";
    stubs.fns.getServer = async () => server({ cleanupEnabled: true, cleanupIntervalHours: 6, cleanupThresholdPct: null });
    mount();
    const text = await stateText();
    expect(text).toContain("Runs every 6 h");
    expect(text).toContain("with no disk-usage trigger");
  });

  it("explicitly OFF is shown as off (no schedule claims) with the way back on", async () => {
    nav.tab = "maintenance";
    stubs.fns.getServer = async () => server({ cleanupEnabled: false, cleanupCron: "0 3 * * *", cleanupThresholdPct: 80 });
    mount();
    const text = await stateText();
    expect(text).toContain("Automatic cleanup is off");
    expect(text).toContain("Nothing is pruned on this server unless you press “Clean now”");
    expect(text).not.toContain("Runs on schedule");
  });

  it("states the defaults and what it deletes and never deletes", async () => {
    nav.tab = "maintenance";
    stubs.fns.getServer = async () => server({ cleanupEnabled: true });
    mount();
    await stateText();
    expect(screen.getByText(/dangling image layers and build cache older than 7 days/)).toBeInTheDocument();
    expect(screen.getByText(/Never deleted: app images \(including rollback versions\), stopped containers, networks and volumes/)).toBeInTheDocument();
    expect(screen.getByText("Defaults for every server: on, daily at 03:00, and also whenever disk usage reaches 80%.")).toBeInTheDocument();
  });

  it("the threshold field is labelled as an extra trigger, not a gate", async () => {
    nav.tab = "maintenance";
    stubs.fns.getServer = async () => server({ cleanupEnabled: true, cleanupThresholdPct: 80 });
    mount();
    await stateText();
    expect(screen.getByLabelText("Also at disk %")).toHaveValue(80);
    expect(screen.getByText(/also runs when this server's disk usage reaches this percentage/)).toBeInTheDocument();
  });
});
