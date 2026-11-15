import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ConfirmProvider } from "../../../../components/confirm";
import { api } from "../../../../lib/api";
import type { Application } from "../../../../lib/types";
import AppDetailPage from "./page";

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "app1" }),
  usePathname: () => "/apps/app1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => nav,
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("../../../../components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../../../../hooks/useDeployLogStream", () => ({ useDeployLogStream: () => ({ lines: [], done: false, status: null, exitCode: null }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const app = (over: Partial<Application> = {}): Application =>
  ({
    id: "app1", name: "blog", description: null, source: "IMAGE", image: "nginx:alpine", status: "RUNNING", teamId: "t1", serverId: "s1", environmentId: "e1",
    projectId: "p1", projectName: "Shop", environmentName: "prod", canWrite: true, canDeploy: true, links: [], url: null, domain: null, domainKind: "none",
    volumes: [], hostMounts: [], composeVolumes: [], extraPorts: [], networkAliases: [], networks: [], tags: [], watchPaths: [], extraDomains: [], ipAllowlist: [],
    basicAuthUsers: [], redirects: [], envCount: 0, isPreview: false, clusterId: null, previewExcludeKeys: [], zeroDowntime: true, imageUpdate: null,
    webhookToken: null, webhookSecret: null, containerHealth: { state: "healthy", checkType: "NONE", containers: 1 }, move: null,
    ...over,
  }) as unknown as Application;

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <AppDetailPage />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("app page while the app is being moved", () => {
  beforeEach(() => {
    vi.spyOn(api, "getDeployments").mockResolvedValue([]);
    vi.spyOn(api, "listServers").mockResolvedValue([]);
    vi.spyOn(api, "getAppMoves").mockResolvedValue([]);
  });

  it("deploy / restart / stop are disabled with the move tooltip, and the config area is a disabled fieldset", async () => {
    vi.spyOn(api, "getApp").mockResolvedValue(app({ move: { id: "mv1", phase: "TRANSFERRING" } }));
    show();
    const redeploy = (await screen.findByRole("button", { name: "Redeploy" })) as HTMLButtonElement;
    expect(redeploy.disabled).toBe(true);
    expect(redeploy.title).toMatch(/being moved to another server/);
    expect((screen.getByRole("button", { name: "Restart" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
    const lock = await screen.findAllByLabelText(/being moved to another server/);
    expect(lock.some((el) => el.tagName === "FIELDSET" && (el as HTMLFieldSetElement).disabled)).toBe(true);
  });

  it("without a move the same controls are enabled and nothing is locked", async () => {
    vi.spyOn(api, "getApp").mockResolvedValue(app());
    show();
    const redeploy = (await screen.findByRole("button", { name: "Redeploy" })) as HTMLButtonElement;
    await waitFor(() => expect(redeploy.disabled).toBe(false));
    expect((screen.getByRole("button", { name: "Restart" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryAllByLabelText(/being moved to another server/)).toEqual([]);
  });
});
