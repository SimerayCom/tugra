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

const server = (o: Partial<ServerView> = {}): ServerView =>
  ({
    id: "s1", name: "box", status: "ONLINE", teamId: "t1", clusterId: null, clusterName: null, hostname: null, publicIp: "1.2.3.4",
    publicIpv6: null, ipSource: "observed", wildcardDomain: null, magicSuffix: null, certMode: "http", dnsProvider: null,
    customCertResolver: null, hasDnsCreds: false, os: null, osVersion: null, arch: null, kernel: null, agentVersion: "0.1.0",
    cpuCores: null, memTotalBytes: null, uptimeSeconds: null, cleanupEnabled: false, cleanupIntervalHours: null, cleanupCron: null,
    cleanupThresholdPct: null, cleanupVolumes: false, description: null, timezone: null, lastCleanupAt: null, lastSeenAt: null,
    createdAt: "", seal: null, tags: [], capabilities: [], isLocal: false, proxyBind: "public", trafficAnalytics: false, provider: null,
    providerServerId: null, canWrite: true, canOps: true, ...o,
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

beforeEach(() => {
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
    supported: true, manager: "apt", checkFailed: false, rebootRequired: false, count: 1,
    packages: [{ name: "openssl", current: "1", candidate: "2" }], ...o,
  });

  it("patch apply toasts completion and a reboot-required notice from the re-check", async () => {
    nav.tab = "updates";
    let calls = 0;
    stubs.fns.checkUpdates = async () => (++calls === 1 ? pkgInfo() : pkgInfo({ rebootRequired: true }));
    stubs.fns.upgradeAll = async () => ({ output: "done", exitCode: 0 });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toastTexts()).toContain("Updates applied"));
    await waitFor(() => expect(toastTexts()).toContain("Updates applied — a reboot is required to finish them."));
  });

  it("a non-zero apply exit toasts a failure instead of success", async () => {
    nav.tab = "updates";
    stubs.fns.checkUpdates = async () => pkgInfo();
    stubs.fns.upgradeAll = async () => ({ output: "E: broken", exitCode: 100 });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toasts.some((t) => t.type === "error" && /did not finish cleanly/.test(t.message))).toBe(true));
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
