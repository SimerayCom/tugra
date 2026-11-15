import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ConfirmProvider } from "../../../../components/confirm";
import { api } from "../../../../lib/api";
import type { Application } from "../../../../lib/types";
import AppDetailPage from "./page";

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "app1" }),
  usePathname: () => "/apps/app1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => nav,
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("../../../../components/toast", () => ({ useToast: () => toastSpy }));
vi.mock("../../../../hooks/useDeployLogStream", () => ({ useDeployLogStream: () => ({ lines: [], done: false, status: null, exitCode: null }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toastSpy.mockReset();
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

describe("app lifecycle feedback", () => {
  beforeEach(() => {
    vi.spyOn(api, "getDeployments").mockResolvedValue([]);
    vi.spyOn(api, "listServers").mockResolvedValue([]);
    vi.spyOn(api, "getAppMoves").mockResolvedValue([]);
    vi.spyOn(api, "getApp").mockResolvedValue(app());
  });

  it("confirms a restart with a named success toast (the status stays RUNNING, so nothing else changes)", async () => {
    const restart = vi.spyOn(api, "restartApp").mockResolvedValue({ ok: true } as never);
    show();
    const btn = (await screen.findByRole("button", { name: "Restart" })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(restart).toHaveBeenCalledWith("app1"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith("blog restarted.", "success"));
  });

  it("reports a failed restart as an error toast and never claims success", async () => {
    vi.spyOn(api, "restartApp").mockRejectedValue(new Error("agent offline"));
    show();
    const btn = (await screen.findByRole("button", { name: "Restart" })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith("agent offline", "error"));
    expect(toastSpy).not.toHaveBeenCalledWith(expect.stringContaining("restarted"), "success");
  });

  it("confirms a start with a named success toast", async () => {
    vi.spyOn(api, "getApp").mockResolvedValue(app({ status: "STOPPED" }));
    vi.spyOn(api, "startApp").mockResolvedValue({ ok: true } as never);
    show();
    const btn = (await screen.findByRole("button", { name: "Start" })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith("blog started.", "success"));
  });
});
