import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ToastProvider } from "./toast";
import { ConfigMountsCard } from "./config-mounts-card";
import { api } from "../lib/api";
import type { AppConfigMount } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>{ui}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const MOUNTS: AppConfigMount[] = [
  { serviceName: "redis", target: "/etc/redis.conf", mode: "0600", content: "appendonly yes\n" },
  { serviceName: "web", target: "/etc/app.conf", mode: null, content: "a=1\n" },
];

describe("ConfigMountsCard", () => {
  it("renders a textarea per mount (service/target read-only) with Save disabled until edited", async () => {
    vi.spyOn(api, "getAppConfigMounts").mockResolvedValue(MOUNTS);
    wrap(<ConfigMountsCard id="a1" onDeploy={() => {}} />);
    const ta = await screen.findByLabelText("/etc/redis.conf");
    expect(screen.getByLabelText("/etc/app.conf")).toBeTruthy();
    expect(screen.getByText("redis")).toBeTruthy(); // serviceName shown as a read-only chip
    expect((screen.getAllByText("Save")[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(ta, { target: { value: "appendonly no\n" } });
    expect((screen.getAllByText("Save")[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it("Save sends only {target, content}", async () => {
    vi.spyOn(api, "getAppConfigMounts").mockResolvedValue(MOUNTS);
    const set = vi.spyOn(api, "setAppConfigMount").mockResolvedValue({ ok: true } as { ok: true });
    wrap(<ConfigMountsCard id="a1" onDeploy={() => {}} />);
    const ta = await screen.findByLabelText("/etc/redis.conf");
    fireEvent.change(ta, { target: { value: "appendonly no\n" } });
    fireEvent.click(screen.getAllByText("Save")[0]);
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { target: "/etc/redis.conf", content: "appendonly no\n" }));
  });

  it("Save & deploy that fails never triggers onDeploy", async () => {
    vi.spyOn(api, "getAppConfigMounts").mockResolvedValue(MOUNTS);
    const onDeploy = vi.fn();
    const set = vi.spyOn(api, "setAppConfigMount").mockRejectedValueOnce(new Error("a deployment is already running"));
    wrap(<ConfigMountsCard id="a1" onDeploy={onDeploy} />);
    const ta = await screen.findByLabelText("/etc/redis.conf");
    fireEvent.change(ta, { target: { value: "x\n" } });
    fireEvent.click(screen.getAllByText("Save & deploy")[0]);
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(onDeploy).not.toHaveBeenCalled();
  });

  it("renders nothing when the app has no config mounts", async () => {
    vi.spyOn(api, "getAppConfigMounts").mockResolvedValue([]);
    const { container } = wrap(<ConfigMountsCard id="a1" onDeploy={() => {}} />);
    await waitFor(() => expect(api.getAppConfigMounts).toHaveBeenCalled());
    expect(container.querySelector("textarea")).toBeNull();
  });
});
