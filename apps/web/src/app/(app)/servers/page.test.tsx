import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { TeamScopeProvider } from "../../../components/team-scope";
import { api } from "../../../lib/api";
import ServersPage from "./page";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const srv = (id: string, teamId: string) =>
  ({ id, name: `box-${id}`, status: "ONLINE", teamId, clusterId: null, clusterName: null, hostname: `${id}.example.com`, publicIp: null, publicIpv6: null, tags: [], canWrite: true, lastSeenAt: null }) as never;

let qc: QueryClient;
beforeEach(() => {
  localStorage.clear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "listServers").mockResolvedValue([srv("1", "t1"), srv("2", "t1"), srv("3", "t2"), srv("4", "t2"), srv("5", "t2")]);
  vi.spyOn(api, "listTeams").mockResolvedValue([
    { id: "t1", name: "Olgu Bey", role: "OWNER" },
    { id: "t2", name: "Acme", role: "OWNER" },
  ] as never);
  vi.spyOn(api, "getFleetTrend").mockResolvedValue([]);
  vi.spyOn(api, "getInstanceVersion").mockResolvedValue({ current: "1.0.0", latest: null } as never);
});
afterEach(() => vi.restoreAllMocks());

const show = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <TeamScopeProvider>
          <ServersPage />
        </TeamScopeProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("Servers page header and the team switcher", () => {
  it("with no team picked the total is plain and true", async () => {
    show();
    expect(await screen.findByRole("button", { name: "5 total" })).toBeTruthy();
    expect(screen.queryByText(/all teams/)).toBeNull();
  });

  it("with a team picked it says how many are in that team and how many in all teams", async () => {
    localStorage.setItem("tugra.teamScope", "t1");
    show();
    expect(await screen.findByRole("button", { name: "2 in Olgu Bey · 5 in all teams" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/2 total \(all teams\)/)).toBeNull());
  });
});
