import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { HubHealth, PublicUser } from "../../../lib/types";
import { HubHealthAttention } from "../../../components/dashboard/hub-health-attention";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { HubHealthCard } from "./hub-health-card";

const HEALTH: HubHealth = {
  sampledAt: "2026-11-25T10:00:00.000Z",
  healthy: true,
  warnings: [],
  startedAt: "2026-11-25T08:00:00.000Z",
  uptimeSec: 7200,
  restarts: { last24h: 1, lastBootAt: "2026-11-25T08:00:00.000Z" },
  process: { rssMb: 211.4, heapUsedMb: 90, heapLimitMb: 768, heapPct: 11.7, externalMb: 4, gcMs: 2 },
  eventLoop: { p50Ms: 1.2, p99Ms: 9.5, maxMs: 30 },
  history: [
    { t: 1, rssMb: 200, heapUsedMb: 80, loopP99Ms: 5 },
    { t: 2, rssMb: 210, heapUsedMb: 90, loopP99Ms: 9 },
  ],
  postgres: { connectionsUsed: 12, connectionsMax: 100, dbSizeBytes: 5_000_000_000, tables: [{ name: "ContainerMetricRollup", bytes: 4_000_000_000 }] },
  redis: { usedMemoryBytes: 20_000_000, maxMemoryBytes: 0, connectedClients: 6 },
  queues: [{ name: "monitors", waiting: 0, active: 1, delayed: 3, failed: 0, lastDurationMs: 42 }],
};

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("HubHealthCard", () => {
  it("renders nothing for a non-owner and never fetches", () => {
    h.user = { isInstanceOwner: false };
    const spy = vi.spyOn(api, "getHubHealth").mockResolvedValue(HEALTH);
    wrap(<HubHealthCard />);
    expect(screen.queryByText("Hub health")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows the owner the process, Postgres, Redis and queue figures", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getHubHealth").mockResolvedValue(HEALTH);
    wrap(<HubHealthCard />);
    expect(await screen.findByText("Healthy")).toBeTruthy();
    expect(screen.getByText("211 MB")).toBeTruthy();
    expect(screen.getByText(/90 \/ 768 MB/)).toBeTruthy();
    expect(screen.getByText("p50 1.2 ms · p99 9.5 ms")).toBeTruthy();
    expect(screen.getByText("ContainerMetricRollup")).toBeTruthy();
    expect(screen.getByText("monitors")).toBeTruthy();
    expect(screen.getByText(/Connections 12 \/ 100/)).toBeTruthy();
  });

  it("lists the warnings and flags the card when unhealthy", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getHubHealth").mockResolvedValue({ ...HEALTH, healthy: false, warnings: [{ code: "heap_high", value: 85, limit: 80 }] });
    wrap(<HubHealthCard />);
    expect(await screen.findByText("Needs a look")).toBeTruthy();
    expect(screen.getByText("Heap is at 85% of its limit (warns at 80%).")).toBeTruthy();
  });

  it("degrades per section when Postgres / Redis could not be read", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getHubHealth").mockResolvedValue({ ...HEALTH, postgres: null, redis: null, queues: [] });
    wrap(<HubHealthCard />);
    expect(await screen.findAllByText("Not available")).toHaveLength(2);
    expect(screen.getByText("No queues yet.")).toBeTruthy();
  });
});

describe("HubHealthAttention", () => {
  it("renders nothing while healthy", () => {
    wrap(<HubHealthAttention warnings={[]} />);
    expect(screen.queryByTestId("hub-health-attention")).toBeNull();
  });
  it("links to the card with the first warning and the count", () => {
    wrap(<HubHealthAttention warnings={[{ code: "restarts", value: 4, limit: 3 }, { code: "loop_lag", value: 300, limit: 250 }]} />);
    expect(screen.getByText("Hub health")).toBeTruthy();
    expect(screen.getByText("The hub restarted 4 times in the last 24 hours.")).toBeTruthy();
    expect(screen.getByText("2 to check")).toBeTruthy();
    expect(document.querySelector("a")?.getAttribute("href")).toBe("/settings?tab=instance&section=general#hub-health");
  });
});
