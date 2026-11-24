import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import type { PublicStatus } from "../../../../lib/types";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "acme" }) }));

import PublicStatusPage from "./page";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const day = (date: string, uptime: number | null) => ({ date, uptime });
const base = (over: Partial<PublicStatus> = {}): PublicStatus => ({
  title: "Acme status",
  description: "Everything we run",
  overall: "partial",
  updatedAt: "2026-11-24T12:00:00.000Z",
  monitors: [
    { name: "Website", status: "up", uptime: 99.9, days: [day("2026-11-23", 100), day("2026-11-24", null)] },
    { name: "API", status: "down", uptime: 90, days: [day("2026-11-23", 80)] },
  ],
  incidents: [
    { monitor: "API", startedAt: "2026-11-24T10:00:00.000Z", resolvedAt: null },
    { monitor: "Website", startedAt: "2026-11-20T10:00:00.000Z", resolvedAt: "2026-11-20T10:30:00.000Z" },
  ],
  maintenance: [{ id: "m1", title: "Database upgrade", body: "Short outage", startsAt: "2026-12-01T01:00:00.000Z", endsAt: "2026-12-01T02:00:00.000Z", state: "scheduled" }],
  emailUpdates: true,
  ...over,
});

function setup(data: PublicStatus | Error) {
  const get = vi.spyOn(api, "getPublicStatus").mockImplementation(async () => { if (data instanceof Error) throw data; return data; });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><I18nProvider><PublicStatusPage /></I18nProvider></QueryClientProvider>);
  return { get };
}

describe("public status page", () => {
  it("shows the banner, each monitor's state, incidents and maintenance", async () => {
    const { get } = setup(base());
    await screen.findByRole("heading", { level: 1, name: "Acme status" });
    expect(get).toHaveBeenCalledWith("acme");
    expect(screen.getByTestId("status-banner").textContent).toContain("Some systems are down");
    expect(screen.getByText("Website")).toBeTruthy();
    expect(screen.getByText("Operational")).toBeTruthy();
    expect(screen.getAllByText("Down").length).toBeGreaterThan(0);
    expect(screen.getByText("API was down")).toBeTruthy();
    expect(screen.getByText("Ongoing")).toBeTruthy();
    expect(screen.getByText("30 min")).toBeTruthy();
    expect(screen.getByText("Database upgrade")).toBeTruthy();
    expect(screen.getByText("99.9% uptime, last 30 days")).toBeTruthy();
  });

  it("offers the RSS feed always and email only when the hub can send it", async () => {
    setup(base({ emailUpdates: false }));
    const rss = await screen.findByRole("link", { name: "RSS feed" });
    expect(rss.getAttribute("href")).toBe("/api/v1/public/status/acme/rss");
    expect(screen.queryByLabelText("Email address")).toBeNull();
  });

  it("subscribes by email", async () => {
    const sub = vi.spyOn(api, "subscribeToStatus").mockResolvedValue({ ok: true });
    setup(base());
    const input = await screen.findByLabelText("Email address");
    fireEvent.change(input, { target: { value: "a@example.com" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(sub).toHaveBeenCalledWith("acme", "a@example.com"));
    await screen.findByText("Check your inbox to confirm.");
  });

  it("says so when the page does not exist", async () => {
    setup(new Error("not found"));
    await screen.findByText("This status page doesn't exist.");
  });
});
