import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import { emitToast, subscribeToast } from "../../../../lib/toast-bus";
import type { Monitor } from "../../../../lib/types";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "m1" }) }));

import MonitorDetailPage from "./page";

const MON = {
  id: "m1", name: "Marketing site", type: "http", target: "https://example.com", status: "UP", canWrite: true, teamId: "t1",
  intervalSec: 30, retries: 0, timeoutMs: 10000, enabled: true, channelIds: [],
} as unknown as Monitor;

afterEach(cleanup);

let toasts: string[];
let off: () => void;
beforeEach(() => {
  toasts = [];
  off = subscribeToast((x) => toasts.push(x.message));
  vi.spyOn(api, "getMonitor").mockResolvedValue(MON);
  vi.spyOn(api, "getHeartbeats").mockResolvedValue([]);
  vi.spyOn(api, "getUptime").mockResolvedValue({ percent: 100, total: 1 });
  vi.spyOn(api, "listChannels").mockResolvedValue([]);
});
afterEach(() => {
  off();
  vi.restoreAllMocks();
});

const show = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          // Mirrors lib/providers.tsx: meta.successMessage becomes a success toast.
          mutationCache: new MutationCache({
            onSuccess: (_d, _v, _c, m) => {
              const msg = m.meta?.successMessage;
              if (typeof msg === "string" && msg) emitToast(msg, "success");
            },
          }),
        })
      }
    >
      <I18nProvider>
        <MonitorDetailPage />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("MonitorDetailPage — feedback", () => {
  it("Check now answers with the result (status + latency)", async () => {
    vi.spyOn(api, "checkMonitor").mockResolvedValue({ status: "UP", ms: 123, msg: "" });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));
    await waitFor(() => expect(toasts).toContain("Marketing site is up (123 ms)"));
  });

  it("saving the settings toasts", async () => {
    vi.spyOn(api, "updateMonitor").mockResolvedValue(MON);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(toasts).toContain("Monitor settings saved"));
  });
});
