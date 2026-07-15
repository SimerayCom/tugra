import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import { DeliveryHistory } from "./delivery-history";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

const rows = [
  // SENT row carries a (hypothetical) lastError — the panel must NOT reveal it (only failed/dead rows do).
  { id: "d1", channelId: "c1", event: "deploy_failed", level: "failure", title: "Deploy failed — blog", summary: "s", status: "SENT", attempts: 1, lastError: "leaked-on-sent", createdAt: "2026-07-16T10:00:00.000Z", sentAt: "2026-07-16T10:00:01.000Z" },
  { id: "d2", channelId: "c1", event: "backup_failed", level: "failure", title: "Backup failed — shop", summary: "s", status: "FAILED", attempts: 3, lastError: "connect ECONNREFUSED 10.0.0.5:443", createdAt: "2026-07-16T09:00:00.000Z", sentAt: null },
];

describe("DeliveryHistory", () => {
  beforeEach(() => { qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
  afterEach(() => vi.restoreAllMocks());

  it("is lazy: does not fetch until the panel is first expanded", async () => {
    const spy = vi.spyOn(api, "listDeliveries").mockResolvedValue(rows as never);
    wrap(<DeliveryHistory channelId="c1" />);
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Delivery history/));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("c1"));
  });

  it("renders rows with status + title and reveals lastError ONLY on failed rows", async () => {
    vi.spyOn(api, "listDeliveries").mockResolvedValue(rows as never);
    wrap(<DeliveryHistory channelId="c1" />);
    fireEvent.click(screen.getByText(/Delivery history/));
    await waitFor(() => expect(screen.getByText("SENT")).toBeTruthy());
    expect(screen.getByText("FAILED")).toBeTruthy();
    expect(screen.getByText("Deploy failed — blog")).toBeTruthy();
    expect(screen.getByText("Backup failed — shop")).toBeTruthy();
    expect(screen.getByText(/ECONNREFUSED/)).toBeTruthy(); // failed row error shown
    expect(screen.queryByText("leaked-on-sent")).toBeNull(); // SENT row error hidden
  });

  it("shows an empty state when there are no deliveries", async () => {
    vi.spyOn(api, "listDeliveries").mockResolvedValue([] as never);
    wrap(<DeliveryHistory channelId="c1" />);
    fireEvent.click(screen.getByText(/Delivery history/));
    await waitFor(() => expect(screen.getByText("No deliveries yet")).toBeTruthy());
  });

  it("shows an error state (not a false empty) when the fetch fails", async () => {
    vi.spyOn(api, "listDeliveries").mockRejectedValue(new Error("boom"));
    wrap(<DeliveryHistory channelId="c1" />);
    fireEvent.click(screen.getByText(/Delivery history/));
    await waitFor(() => expect(screen.getByText("Couldn't load delivery history")).toBeTruthy());
    expect(screen.queryByText("No deliveries yet")).toBeNull(); // an error must not read as "nothing sent"
  });
});
