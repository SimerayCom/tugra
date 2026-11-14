import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import type { Application, AppLink } from "../../../../lib/types";
import { ConfirmProvider } from "../../../../components/confirm";
import { AppOverview, PreviewBadge, PreviewCard, WebhookEventHelp } from "./app-detail-misc-cards";

afterEach(cleanup);

const health = { state: "healthy", checkType: "CMD", containers: 1, observedAt: null } as const;
const app = (links: AppLink[], url: string | null) =>
  ({ id: "a1", status: "RUNNING", containerHealth: health, source: "COMPOSE", exposeMode: "custom", clusterId: null, replicas: null, containerPort: null, memoryMb: null, cpus: null, canWrite: true, url, links }) as unknown as Application;
const show = (a: Application) => render(<I18nProvider><AppOverview app={a} deployments={[]} /></I18nProvider>);

describe("AppOverview — Live URL row", () => {
  it("lists every link as a new-tab anchor, primary first, and labels the non-primary kinds", () => {
    show(
      app(
        [
          { kind: "primary", url: "https://app.example.com", host: "app.example.com", label: null },
          { kind: "service", url: "https://api.example.com", host: "api.example.com", label: "api" },
        ],
        "https://app.example.com",
      ),
    );
    const anchors = screen.getAllByRole("link") as HTMLAnchorElement[];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["https://app.example.com", "https://api.example.com"]);
    for (const a of anchors) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("Service: api")).toBeTruthy();
  });

  it("says the app is not exposed when there are no links", () => {
    show(app([], null));
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});

describe("AppOverview status stat", () => {
  const wrap = (ui: React.ReactElement) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>{ui}</I18nProvider>
      </QueryClientProvider>,
    );
  const mk = (over: Partial<Application>): Application =>
    ({ id: "a1", name: "web", source: "IMAGE", image: "nginx", gitBranch: null, status: "RUNNING", containerHealth: health, exposeMode: "none", clusterId: null, replicas: 1, containerPort: 80, envCount: 0, links: [], url: null, ...over }) as unknown as Application;

  it("renders the localised health-aware label, never the raw enum", () => {
    wrap(<AppOverview app={mk({ containerHealth: { state: "unhealthy", checkType: "CMD", containers: 1, observedAt: null } })} deployments={[]} />);
    expect(screen.getByText("Running (unhealthy)")).toBeTruthy();
    expect(screen.queryByText("RUNNING")).toBeNull();
  });

  it("a RUNNING compose app with no Docker healthcheck reads 'Running (no healthcheck)'", () => {
    wrap(<AppOverview app={mk({ source: "COMPOSE", containerHealth: { state: "none", checkType: "HTTP", containers: 2, observedAt: null } })} deployments={[]} />);
    expect(screen.getByText("Running (no healthcheck)")).toBeTruthy();
  });

  it("lists swap and PID limits in the resources stat when set", () => {
    wrap(<AppOverview app={mk({ memoryMb: 256, memorySwapMb: -1, pidsLimit: 100 })} deployments={[]} />);
    expect(screen.getByText(/256 MB · unlimited swap · 100 PIDs max/)).toBeTruthy();
  });
});

describe("PreviewCard — MR vs PR labels", () => {
  const preview = (over: Record<string, unknown>) => ({ id: "pv1", prNumber: 7, gitBranch: "feat", url: "https://pr7.app.example.com", prProvider: null, prHeadSha: null, ...over });
  const showCard = (previews: unknown[]) => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(["appPreviews", "a1"], previews);
    return render(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <ConfirmProvider>
            <PreviewCard id="a1" previewEnabled domain="app.example.com" excludeKeys={[]} limit={null} />
          </ConfirmProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  };

  it.each([[null], ["github"], ["gitea"], ["forgejo"], ["bitbucket"], ["bitbucket-server"]])("renders 'PR #7' for provider %s", (provider) => {
    showCard([preview({ prProvider: provider })]);
    expect(screen.getByText("PR #7")).toBeTruthy();
    expect(screen.queryByText("MR !7")).toBeNull();
  });

  it("renders 'MR !7' for gitlab, with the short head sha", () => {
    showCard([preview({ prProvider: "gitlab", prHeadSha: "e59094b8de0f2f91abbe4760a52d9137260252d8" })]);
    expect(screen.getByText("MR !7")).toBeTruthy();
    expect(screen.queryByText("PR #7")).toBeNull();
    expect(screen.getByText("e59094b")).toBeTruthy();
  });

  it("shows the fork note", () => {
    showCard([]);
    expect(screen.getByText(/Requests from forks are never deployed/)).toBeTruthy();
  });
});

describe("PreviewBadge", () => {
  const badge = (provider: Parameters<typeof PreviewBadge>[0]["provider"]) => render(<I18nProvider><PreviewBadge provider={provider} n={12} /></I18nProvider>);
  it("reads 'Preview · MR !12' for gitlab and 'Preview · PR #12' otherwise", () => {
    badge("gitlab");
    expect(screen.getByText("Preview · MR !12")).toBeTruthy();
    cleanup();
    badge("gitea");
    expect(screen.getByText("Preview · PR #12")).toBeTruthy();
    cleanup();
    badge(null);
    expect(screen.getByText("Preview · PR #12")).toBeTruthy();
  });
});

describe("WebhookEventHelp", () => {
  it("lists the events to enable for every provider and the delivery-log hint", () => {
    render(<I18nProvider><WebhookEventHelp /></I18nProvider>);
    expect(screen.getByText("Events to enable")).toBeTruthy();
    expect(screen.getByText(/^GitHub: content type/)).toBeTruthy();
    expect(screen.getByText(/^GitLab: the secret above as Secret token/)).toBeTruthy();
    expect(screen.getByText(/^Gitea \/ Forgejo:/)).toBeTruthy();
    expect(screen.getByText(/^Bitbucket Cloud \/ Server:/)).toBeTruthy();
    expect(screen.getByText(/response says why the request was ignored/)).toBeTruthy();
  });
});
