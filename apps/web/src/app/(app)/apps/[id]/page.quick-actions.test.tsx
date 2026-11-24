import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ConfirmProvider } from "../../../../components/confirm";
import { api } from "../../../../lib/api";
import type { Application, Deployment } from "../../../../lib/types";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "app1" }),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/apps/app1",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../../../../components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../../../../hooks/useDeployLogStream", () => ({ useDeployLogStream: () => ({ lines: [], done: false, status: null, exitCode: null }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import AppDetailPage from "./page";

const dep = (id: string, status: Deployment["status"], rollbackable = true) =>
  ({ id, status, kind: "DEPLOY", logs: null, exitCode: 0, imageTag: id, registryImage: null, imageDigest: null, rollbackable, createdAt: "2026-11-24T00:00:00Z" }) as unknown as Deployment;

const app = {
  id: "app1", name: "web", description: null, source: "IMAGE", image: "nginx:alpine", status: "RUNNING", teamId: "t1", serverId: "s1", environmentId: "e1",
  projectId: "p1", projectName: "Shop", environmentName: "prod", canWrite: true, canDeploy: true, links: [], url: null, domain: null, domainKind: "none",
  volumes: [], hostMounts: [], composeVolumes: [], extraPorts: [], networkAliases: [], networks: [], tags: [], watchPaths: [], extraDomains: [], ipAllowlist: [],
  basicAuthUsers: [], redirects: [], envCount: 0, isPreview: false, clusterId: null, previewExcludeKeys: [], zeroDowntime: true, imageUpdate: null,
  webhookToken: null, webhookSecret: null, containerHealth: { state: "healthy", checkType: "NONE", containers: 1 }, move: null,
} as unknown as Application;

let qc: QueryClient;
function mobile(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
}
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider><AppDetailPage /></ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  nav.push.mockReset();
  vi.spyOn(api, "listServers").mockResolvedValue([]);
  vi.spyOn(api, "getAppMoves").mockResolvedValue([]);
  vi.spyOn(api, "getApp").mockResolvedValue(app);
  vi.spyOn(api, "getDeployments").mockResolvedValue([dep("d3", "SUCCESS"), dep("d2", "FAILED"), dep("d1", "SUCCESS")]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("app page quick actions (phones)", () => {
  it("shows the bar on a phone and restarts with the existing endpoint", async () => {
    mobile(true);
    const restart = vi.spyOn(api, "restartApp").mockResolvedValue(undefined as never);
    wrap();
    const bar = await screen.findByTestId("app-quick-actions");
    fireEvent.click(bar.querySelector('button[title="Restart the running container (same image, no rebuild)"]')!);
    await waitFor(() => expect(restart).toHaveBeenCalledWith("app1"));
  });

  it("rolls back to the previous good deployment after confirming, then follows the new deployment", async () => {
    mobile(true);
    const rollback = vi.spyOn(api, "rollbackApp").mockResolvedValue({ id: "d4" } as never);
    wrap();
    const bar = await screen.findByTestId("app-quick-actions");
    const btn = Array.from(bar.querySelectorAll("button")).find((b) => b.textContent?.includes("Roll back"))!;
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    fireEvent.click(await screen.findByRole("button", { name: /confirm|yes|ok/i }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith("app1", "d1")); // d3 is live, d2 failed, d1 is the target
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apps/app1/deployments/d4"));
  });

  it("is not rendered on a desktop viewport", async () => {
    mobile(false);
    wrap();
    await screen.findByRole("heading", { name: "web" });
    expect(screen.queryByTestId("app-quick-actions")).toBeNull();
  });
});
