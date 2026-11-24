import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ToastProvider } from "../../../components/toast";
import { api } from "../../../lib/api";
import { __resetInstallCaptureForTests, PUSH_DEVICE_KEY, startInstallCapture } from "../../../lib/pwa";

const h = vi.hoisted(() => ({ user: { uiMode: "fleet" } as { uiMode: string } }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { InstallAppCard, PushDevicesCard } from "./pwa-card";

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>{ui}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const sub = { endpoint: "https://push.example.com/x", options: {}, toJSON: () => ({ endpoint: "https://push.example.com/x", keys: { p256dh: "P", auth: "A" } }), unsubscribe: vi.fn(async () => true) };
const pushManager = { getSubscription: vi.fn(), subscribe: vi.fn() };

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  localStorage.clear();
  __resetInstallCaptureForTests();
  vi.restoreAllMocks();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", Object.assign(class {}, { permission: "default", requestPermission: vi.fn(async () => "granted") }));
  Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve({ pushManager }) }, configurable: true });
  pushManager.getSubscription.mockResolvedValue(null);
  pushManager.subscribe.mockResolvedValue(sub);
  h.user = { uiMode: "fleet" };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("InstallAppCard", () => {
  it("offers the browser's install prompt once it has been captured", async () => {
    startInstallCapture();
    wrap(<InstallAppCard />);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("Your browser has not offered installation");
    const prompt = vi.fn(async () => {});
    const ev = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome: "accepted" as const }) });
    act(() => { window.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true); // we hold it instead of the browser's own infobar
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
  });

  it("shows the installed state after appinstalled", async () => {
    startInstallCapture();
    wrap(<InstallAppCard />);
    act(() => { window.dispatchEvent(new Event("appinstalled")); });
    expect(await screen.findByText("Installed on this device.")).toBeInTheDocument();
  });
});

describe("PushDevicesCard", () => {
  it("turns push on for this browser: permission, subscribe with the hub key, register the device", async () => {
    vi.spyOn(api, "listPushDevices").mockResolvedValue([]);
    vi.spyOn(api, "pushPublicKey").mockResolvedValue({ publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" });
    const add = vi.spyOn(api, "addPushDevice").mockResolvedValue({ id: "d1", deviceLabel: "Chrome", service: "push.example.com", createdAt: "2026-11-24T00:00:00Z", lastUsedAt: null });
    wrap(<PushDevicesCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on for this device" }));
    await waitFor(() => expect(add).toHaveBeenCalled());
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(add.mock.calls[0][0]).toMatchObject({ endpoint: "https://push.example.com/x", keys: { p256dh: "P", auth: "A" } });
    expect(localStorage.getItem(PUSH_DEVICE_KEY)).toBe("d1");
  });

  it("explains a blocked permission instead of offering the button", async () => {
    vi.spyOn(api, "listPushDevices").mockResolvedValue([]);
    vi.stubGlobal("Notification", Object.assign(class {}, { permission: "denied", requestPermission: vi.fn() }));
    wrap(<PushDevicesCard />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Notifications are blocked for this site");
    expect(screen.queryByRole("button", { name: "Turn on for this device" })).toBeNull();
  });

  it("lists devices, marks this one, removes it on the hub and in the browser, and can send a test", async () => {
    localStorage.setItem(PUSH_DEVICE_KEY, "d1");
    pushManager.getSubscription.mockResolvedValue(sub);
    vi.spyOn(api, "listPushDevices").mockResolvedValue([
      { id: "d1", deviceLabel: "Chrome on macOS", service: "push.example.com", createdAt: "2026-11-20T00:00:00Z", lastUsedAt: null },
      { id: "d2", deviceLabel: null, service: "push.example.com", createdAt: "2026-11-21T00:00:00Z", lastUsedAt: null },
    ]);
    const del = vi.spyOn(api, "removePushDevice").mockResolvedValue({ ok: true });
    const test = vi.spyOn(api, "testPush").mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
    wrap(<PushDevicesCard />);
    expect(await screen.findByText("Chrome on macOS")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn off for this device" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send a test" }));
    await waitFor(() => expect(test).toHaveBeenCalledWith({ title: "Tugra", body: "Push notifications are on." }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Chrome on macOS" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("d1"));
    await waitFor(() => expect(sub.unsubscribe).toHaveBeenCalled());
    expect(localStorage.getItem(PUSH_DEVICE_KEY)).toBeNull();
  });

  it("hides the Notifications link in Home mode", async () => {
    h.user = { uiMode: "home" };
    vi.spyOn(api, "listPushDevices").mockResolvedValue([]);
    wrap(<PushDevicesCard />);
    await screen.findByText("No devices yet.");
    expect(screen.queryByRole("link", { name: "Set up alerts" })).toBeNull();
  });
});
