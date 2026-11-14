import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import type { Application, AppLink } from "../../../../lib/types";
import { AppOverview } from "./app-detail-misc-cards";

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
