import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

describe("app page of a stack adopted in place", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
    vi.spyOn(api, "getDeployments").mockResolvedValue([]);
    vi.spyOn(api, "listServers").mockResolvedValue([]);
    vi.spyOn(api, "getAppMoves").mockResolvedValue([]);
    vi.spyOn(api, "getApp").mockResolvedValue(
      app({ source: "COMPOSE", image: null, composeAdopt: { project: "shop", workingDir: "/srv/shop", files: ["/srv/shop/docker-compose.yml"], services: [{ name: "web", image: "nginx", ports: [80] }] } }),
    );
  });

  it("shows the adopted summary, and the delete dialog says it only unregisters (no volume/image options)", async () => {
    const del = vi.spyOn(api, "deleteApp").mockResolvedValue(undefined as never);
    show();
    expect(await screen.findByText("Adopted compose stack")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(screen.queryByText("Clone")).toBeNull(); // a copy of an adopted stack would have no files
    fireEvent.click(await screen.findByText("Delete"));
    expect(await screen.findByText(/Only the registration is removed/)).toBeTruthy();
    expect(screen.queryByText(/volumes/i, { selector: "label *, label" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(del).not.toHaveBeenCalled();
  });
});
