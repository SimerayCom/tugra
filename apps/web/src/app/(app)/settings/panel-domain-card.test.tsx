import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ToastProvider } from "../../../components/toast";
import { api } from "../../../lib/api";
import type { PanelDomainStatus, PublicUser } from "../../../lib/types";
import settings from "../../../i18n/locales/en/settings.json";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { PanelDomainCard } from "./panel-domain-card";

const IDLE = { phase: "idle", action: null, domain: null, targetUrl: null, error: null, code: null, detail: null, startedAt: null } as const;
const IP_MODE: PanelDomainStatus = { mode: "ip", domain: null, url: "http://203.0.113.9", ipRoute: true, localServerOnline: true, acmeEmail: null, job: { ...IDLE } };
const DOMAIN_MODE: PanelDomainStatus = { ...IP_MODE, mode: "domain", domain: "panel.example.com", url: "https://panel.example.com", ipRoute: false };

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <PanelDomainCard />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
const owner = () => {
  h.user = { isInstanceOwner: true };
};

describe("PanelDomainCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "getPanelDomain").mockResolvedValue({ ...IP_MODE });
    vi.spyOn(api, "setPanelDomain").mockResolvedValue({ ...IP_MODE });
    vi.spyOn(api, "removePanelDomain").mockResolvedValue({ ...DOMAIN_MODE });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches", () => {
    wrap();
    expect(screen.queryByText("Panel domain")).toBeNull();
    expect(api.getPanelDomain).not.toHaveBeenCalled();
  });

  it("ip mode: says where the panel is served and offers the domain form; no Cloudflare token field anywhere", async () => {
    owner();
    wrap();
    expect(await screen.findByText(/Open at http:\/\/203\.0\.113\.9/)).toBeTruthy();
    expect(screen.getByLabelText("Domain")).toBeTruthy();
    expect(screen.getByLabelText(/Let's Encrypt email \(optional\)/)).toBeTruthy();
    expect(screen.queryByText(/token/i, { selector: "label" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove domain" })).toBeNull();
  });

  it("an invalid domain is rejected in the form (no request); a valid one is lowercased and sent without an empty email", async () => {
    owner();
    wrap();
    await screen.findByText(/Open at/);
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "https://panel.example.com/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Set domain" }));
    expect(await screen.findByText(/Enter a bare hostname/)).toBeTruthy();
    expect(api.setPanelDomain).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "Panel.Example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Set domain" }));
    await waitFor(() => expect(api.setPanelDomain).toHaveBeenCalledWith({ domain: "panel.example.com" }));
  });

  it("sends the optional email when given", async () => {
    owner();
    wrap();
    await screen.findByText(/Open at/);
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "panel.example.com" } });
    fireEvent.change(screen.getByLabelText(/Let's Encrypt email/), { target: { value: "ops@real-domain.io" } });
    fireEvent.click(screen.getByRole("button", { name: "Set domain" }));
    await waitFor(() => expect(api.setPanelDomain).toHaveBeenCalledWith({ domain: "panel.example.com", acmeEmail: "ops@real-domain.io" }));
  });

  it("a running change shows the steps and, while switching, links to the NEW address; the form is hidden", async () => {
    owner();
    vi.spyOn(api, "getPanelDomain").mockResolvedValue({ ...IP_MODE, job: { ...IDLE, phase: "switching", action: "set", domain: "panel.example.com", targetUrl: "https://panel.example.com", startedAt: "2026-11-23T10:00:00Z" } });
    wrap();
    expect(await screen.findByText(/Waiting for the Let's Encrypt certificate/)).toBeTruthy();
    expect(screen.getByText(/Switching the panel address and restarting the hub/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open https://panel.example.com" });
    expect(link.getAttribute("href")).toBe("https://panel.example.com");
    expect(screen.queryByLabelText("Domain")).toBeNull();
  });

  it("a failed certificate shows the ROLLBACK message, the Cloudflare hint (Full / Always Use HTTPS) and the proxy log; Try again is offered", async () => {
    owner();
    vi.spyOn(api, "getPanelDomain").mockResolvedValue({
      ...IP_MODE,
      job: { ...IDLE, phase: "failed", action: "set", domain: "panel.example.com", code: "cert_timeout", error: "x", detail: "Unable to obtain ACME certificate" },
    });
    wrap();
    expect(await screen.findByText(/The change did not go through/)).toBeTruthy();
    expect(screen.getByText(/Your previous address still works and nothing else was touched/)).toBeTruthy();
    expect(screen.getByText(/SSL\/TLS mode is Full/)).toBeTruthy();
    expect(screen.getByText(/Always Use HTTPS/)).toBeTruthy();
    expect(screen.getByText(/Unable to obtain ACME certificate/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("an update helper without support names the fix instead of a raw error", async () => {
    owner();
    vi.spyOn(api, "getPanelDomain").mockResolvedValue({ ...IP_MODE, job: { ...IDLE, phase: "failed", action: "set", domain: "panel.example.com", code: "updater_stale", error: "x" } });
    wrap();
    expect(await screen.findByText(/Update the helper first \(Settings → Updates\)/)).toBeTruthy();
  });

  it("an unreachable new address says it was reverted; an unverified restore does NOT claim the old address works", async () => {
    owner();
    const spy = vi.spyOn(api, "getPanelDomain");
    spy.mockResolvedValue({ ...IP_MODE, job: { ...IDLE, phase: "failed", action: "set", domain: "panel.example.com", code: "unreachable", error: "did not answer" } });
    const { unmount } = wrap();
    expect(await screen.findByText(/your previous address works again/)).toBeTruthy();
    expect(screen.getByText(/SSL\/TLS mode to Full \(not Flexible\)/)).toBeTruthy();
    unmount();
    spy.mockResolvedValue({ ...IP_MODE, job: { ...IDLE, phase: "failed", action: "set", domain: "panel.example.com", code: "restore_unverified", error: "x" } });
    wrap();
    expect(await screen.findByText(/previous setup could not be confirmed healthy/)).toBeTruthy();
    expect(screen.queryByText(/previous address still works/)).toBeNull();
  });

  it("while a REMOVE is switching, the link points at the new http://<ip> address, not the domain being removed", async () => {
    owner();
    vi.spyOn(api, "getPanelDomain").mockResolvedValue({ ...DOMAIN_MODE, job: { ...IDLE, phase: "switching", action: "remove", targetUrl: "http://203.0.113.9", startedAt: "2026-11-23T10:00:00Z" } });
    wrap();
    const link = await screen.findByRole("link", { name: "Open http://203.0.113.9" });
    expect(link.getAttribute("href")).toBe("http://203.0.113.9");
  });

  it("domain mode: shows the domain, a Change button and Remove (after a confirm) that calls the API", async () => {
    owner();
    vi.spyOn(api, "getPanelDomain").mockResolvedValue({ ...DOMAIN_MODE });
    wrap();
    expect(await screen.findByText(/Served at https:\/\/panel\.example\.com/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change domain" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove domain" }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.removePanelDomain).toHaveBeenCalledWith({}));
  });

  it("Remove asks for the server IP when the hub does not know it, then sends it", async () => {
    owner();
    vi.spyOn(api, "getPanelDomain").mockResolvedValue({ ...DOMAIN_MODE });
    vi.spyOn(api, "removePanelDomain").mockRejectedValueOnce(new Error("this server's public IP is not known — pass publicIp so the panel URL can go back"));
    wrap();
    await screen.findByText(/Served at/);
    fireEvent.click(screen.getByRole("button", { name: "Remove domain" }));
    const ipField = await screen.findByLabelText("Server public IP");
    fireEvent.change(ipField, { target: { value: "198.51.100.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove domain" }));
    await waitFor(() => expect(api.removePanelDomain).toHaveBeenLastCalledWith({ publicIp: "198.51.100.4" }));
  });

  it("an offline local server blocks the change and says why", async () => {
    owner();
    vi.spyOn(api, "getPanelDomain").mockResolvedValue({ ...IP_MODE, localServerOnline: false });
    wrap();
    expect(await screen.findByText(/local server is offline/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "panel.example.com" } });
    expect((screen.getByRole("button", { name: "Set domain" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("PanelDomainCard i18n coverage", () => {
  const card = readFileSync(path.resolve(__dirname, "panel-domain-card.tsx"), "utf8");
  const dict = settings as Record<string, unknown>;
  it("every literal settings.* key the card uses exists in settings.json", () => {
    const used = [...card.matchAll(/["'`]settings\.([A-Za-z0-9_]+)["'`]/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(15);
    for (const k of used) expect(typeof dict[k], k).toBe("string");
  });
  it("every failure code has its own message (the key is built from the code)", () => {
    for (const code of ["cert_timeout", "proxy_failed", "updater_stale", "updater_failed", "interrupted"]) {
      expect(typeof dict[`panelDomain_fail_${code}`], code).toBe("string");
    }
  });
  it("the card has no hardcoded user-visible English beyond the placeholder examples", () => {
    expect(card).not.toMatch(/>\s*[A-Z][a-z]+ [a-z]+[^<{]*</); // no raw sentences between tags
  });
});
