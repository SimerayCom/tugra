import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { MainIp, ServerAddresses } from "./server-addresses";
import { api } from "../lib/api";
import type { ServerView } from "../lib/types";

afterEach(cleanup);
beforeEach(() => vi.restoreAllMocks());

const server = (over: Partial<ServerView> = {}): ServerView =>
  ({
    id: "s1",
    publicIp: "203.0.113.7",
    publicIpv6: "2001:db8::1",
    ipSource: "metadata",
    ipv6Source: "reported",
    reportedIps: ["10.0.0.5", "203.0.113.7", "203.0.113.8", "2001:db8::1"],
    canWrite: true,
    ...over,
  }) as unknown as ServerView;

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider>{ui}</I18nProvider>
  </QueryClientProvider>
);

describe("MainIp", () => {
  it("shows the address and where it came from", () => {
    render(wrap(<MainIp server={server()} />));
    expect(screen.getByText("203.0.113.7")).toBeTruthy();
    expect(screen.getByText("from the cloud provider")).toBeTruthy();
  });
  it("says Unknown (never a blank dash) when nothing was detected", () => {
    render(wrap(<MainIp server={server({ publicIp: null, publicIpv6: null })} />));
    expect(screen.getByText(/Unknown/)).toBeTruthy();
    expect(screen.getByText(/Enter it under Network/)).toBeTruthy();
  });
  it("falls back to the IPv6 and its own source when there is no IPv4", () => {
    render(wrap(<MainIp server={server({ publicIp: null })} />));
    expect(screen.getByText("2001:db8::1")).toBeTruthy();
    expect(screen.getByText("from the server's network interface")).toBeTruthy();
  });
});

describe("ServerAddresses", () => {
  it("lists every address behind a disclosure with family and kind", () => {
    render(wrap(<ServerAddresses server={server()} />));
    expect(screen.getByText("All addresses (4)")).toBeTruthy();
    expect(screen.getByText("10.0.0.5")).toBeTruthy();
    expect(screen.getAllByText("Main").length).toBe(2);
  });
  it("lets a writer make another public address the main one, pinned per family", async () => {
    const spy = vi.spyOn(api, "setServerNetwork").mockResolvedValue({ ok: true });
    render(wrap(<ServerAddresses server={server()} />));
    const buttons = screen.getAllByRole("button", { name: "Use as main" });
    expect(buttons.length).toBe(1); // only 203.0.113.8: the private one and the two mains have none
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s1", { publicIp: "203.0.113.8" }));
  });
  it("lets a writer clear a pinned IPv6 (and IPv4) so detection resumes for that family", async () => {
    const spy = vi.spyOn(api, "setServerNetwork").mockResolvedValue({ ok: true });
    render(wrap(<ServerAddresses server={server({ ipv6Source: "manual" })} />));
    const buttons = screen.getAllByRole("button", { name: "Detect automatically" });
    expect(buttons.length).toBe(1); // only the IPv6 main is pinned
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s1", { publicIpv6: null }));
  });
  it("offers no reset when the main address is detected, not pinned", () => {
    render(wrap(<ServerAddresses server={server()} />));
    expect(screen.queryByRole("button", { name: "Detect automatically" })).toBeNull();
  });
  it("offers no action to a read-only viewer", () => {
    render(wrap(<ServerAddresses server={server({ canWrite: false })} />));
    expect(screen.queryByRole("button", { name: "Use as main" })).toBeNull();
  });
  it("renders nothing when there are no addresses", () => {
    const { container } = render(wrap(<ServerAddresses server={server({ publicIp: null, publicIpv6: null, reportedIps: [] })} />));
    expect(container.querySelector("details")).toBeNull();
  });
});
