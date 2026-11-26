import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { MoveOffHub, MoveOffServerRow, MoveOffStatusView } from "@tugra/shared";
import { I18nProvider } from "../i18n/provider";
import { api } from "../lib/api";
import { CoolifyHostCard } from "./coolify-host-card";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

afterEach(cleanup);

const row = (o: Partial<MoveOffServerRow>): MoveOffServerRow => ({ serverId: "s1", name: "box", agentOnline: true, coolify: true, isCoolifyHub: false, takeover: "none", cleanup: "none", stage: "takeover", ...o });
const hub = (o: Partial<MoveOffHub> = {}): MoveOffHub => ({ serverId: "s1", teamId: "t1", name: "box", readAt: new Date(Date.now() - 5 * 60_000).toISOString(), knownServers: 27, unlinkedServers: 0, secrets: "none", secretsExpiresAt: null, ssh: null, ...o });
const view = (servers: MoveOffServerRow[], h: MoveOffHub | null = null): MoveOffStatusView => ({
  teamId: "t1",
  hub: h,
  servers,
  campaigns: [],
  projectMoves: { total: 0, active: 0, completed: 0, failed: 0, latestPhase: null },
  steps: [],
});

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.restoreAllMocks();
});
const show = (props: Partial<React.ComponentProps<typeof CoolifyHostCard>> = {}) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <CoolifyHostCard serverId="s1" serverName="box" teamId="t1" role="OWNER" {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("CoolifyHostCard", () => {
  it("on the Coolify host: one status line per thing, each with a link where it opens something", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ isCoolifyHub: true, stage: "hub" })], hub({ ssh: { runId: "r", finished: false, online: 3, failed: 1, skipped: 0, pending: 1, total: 5 } })));
    show();
    await screen.findByTestId("coolify-host-card");
    expect(screen.getByTestId("line-read").textContent).toMatch(/Read .* 27 servers known/);
    expect(screen.getByTestId("line-agents").textContent).toMatch(/3 of 5 online, 1 failed, 1 in progress/);
    expect(screen.getByTestId("line-secrets").textContent).toMatch(/Not allowed/);
    expect(screen.getByTestId("line-hub-last").textContent).toMatch(/shut down last/);
    expect(screen.getByTestId("line-read").querySelector("a")?.getAttribute("href")).toBe("/import/coolify-host?server=s1");
    expect(screen.getByTestId("line-agents").querySelector("a")?.getAttribute("href")).toBe("/import/coolify-host?server=s1");
    expect(screen.getByRole("link", { name: "Open the checklist" }).getAttribute("href")).toBe("/import/move-off-coolify");
  });

  it("says when the consent to read secrets is active and until when", async () => {
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ isCoolifyHub: true, stage: "hub" })], hub({ secrets: "active", secretsExpiresAt: until })));
    show();
    await screen.findByTestId("coolify-host-card");
    expect(screen.getByTestId("line-secrets").textContent).toMatch(/^Read secret valuesAllowed until /);
  });

  it("opens the consent form from the card, for an owner", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ isCoolifyHub: true, stage: "hub" })], hub()));
    vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Allow or stop reading secret values" }));
    await screen.findByTestId("secrets-consent");
  });

  it("a cleanup that failed only because no Coolify read knows the server is neutral, with a link to read the Coolify", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ cleanup: "FAILED", cleanupFailure: "no_coolify_link", stage: "takeover" })], hub({ serverId: "hubid" })));
    show();
    await screen.findByTestId("coolify-host-card");
    const line = screen.getByTestId("line-cleanup");
    expect(line.textContent).toMatch(/Read the Coolify first/);
    expect(line.textContent).not.toMatch(/Failed/);
    expect(line.querySelector("a")?.getAttribute("href")).toBe("/import/coolify-host?server=hubid");
  });

  it("the read link stays the plain page when no Coolify host is known yet", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ cleanup: "FAILED", cleanupFailure: "no_coolify_link", stage: "takeover" })], null));
    show();
    await screen.findByTestId("coolify-host-card");
    expect(screen.getByTestId("line-cleanup").querySelector("a")?.getAttribute("href")).toBe("/import/coolify-host");
  });

  it("a cleanup that really failed still says Failed", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ cleanup: "FAILED", cleanupFailure: "partial", stage: "cleanup", takeover: "VERIFIED" })], hub({ serverId: "hubid" })));
    show();
    await screen.findByTestId("coolify-host-card");
    expect(screen.getByTestId("line-cleanup").textContent).toMatch(/Failed/);
  });

  it("on a server Coolify manages: agent, takeover, cleanup and the next step", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ takeover: "VERIFIED", cleanup: "READY", stage: "cleanup" })], hub({ serverId: "hubid" })));
    show();
    await screen.findByTestId("coolify-host-card");
    expect(screen.getByTestId("line-agent").textContent).toMatch(/Online/);
    expect(screen.getByTestId("line-takeover").textContent).toMatch(/Verified/);
    expect(screen.getByTestId("line-takeover").querySelector("a")?.getAttribute("href")).toBe("/import/inplace?serverId=s1");
    expect(screen.getByTestId("line-cleanup").textContent).toMatch(/Ready to clean/);
    expect(screen.getByTestId("line-next").textContent).toMatch(/Check and clean up Coolify's leftovers/);
  });

  it("a takeover not started has a Take over in place button that starts the flow itself, not a link to an empty screen", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ stage: "takeover" })], hub({ serverId: "hubid" })));
    vi.spyOn(api, "listMigrationRuns").mockResolvedValue([]);
    const connect = vi.spyOn(api, "importConnectAgent").mockResolvedValue({ sessionId: "sess-1234abcd", expiresAt: "x", read: {} } as never);
    show();
    await screen.findByTestId("coolify-host-card");
    expect(screen.getByTestId("line-takeover").querySelector("a")).toBeNull();
    fireEvent.click(within(screen.getByTestId("line-takeover")).getByRole("button", { name: "Take over in place" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/import"));
    expect(connect).toHaveBeenCalledWith({ teamId: "t1", serverId: "hubid" });
  });

  it("a takeover that is already started keeps opening it; a server that is not ready has no button", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ stage: "cleanup", takeover: "VERIFIED" })], hub({ serverId: "hubid" })));
    show();
    await screen.findByTestId("coolify-host-card");
    expect(within(screen.getByTestId("line-takeover")).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("line-takeover").querySelector("a")?.getAttribute("href")).toBe("/import/inplace?serverId=s1");
  });

  it("an offline agent is shown as such", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ agentOnline: false, stage: "agent" })], hub({ serverId: "hubid" })));
    show();
    await screen.findByTestId("coolify-host-card");
    expect(screen.getByTestId("line-agent").textContent).toMatch(/Offline/);
    expect(screen.getByTestId("line-next").textContent).toMatch(/Bring the agent back online/);
  });

  it("renders nothing for a server Coolify is not part of", async () => {
    const spy = vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({ coolify: false, stage: "not_coolify" })], null));
    const { container } = show();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("[data-testid=coolify-host-card]")).toBeNull();
  });

  it("asks the hub nothing for a member who is neither owner nor admin", async () => {
    const spy = vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view([row({})]));
    const { container } = show({ role: "VIEWER" });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
    cleanup();
    show({ role: undefined });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
  });

  it("renders nothing when the status cannot be read", async () => {
    const spy = vi.spyOn(api, "coolifyMoveStatus").mockRejectedValue(new Error("boom"));
    const { container } = show();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("[data-testid=coolify-host-card]")).toBeNull();
  });
});
