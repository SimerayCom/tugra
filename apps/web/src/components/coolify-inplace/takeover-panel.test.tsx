import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { TakeoverItemView, TakeoverStatus, TakeoverView } from "@tugra/shared";
import { I18nProvider } from "../../i18n/provider";
import { ToastProvider } from "../toast";
import { api, ApiError } from "../../lib/api";
import { TakeoverPanel, takeoverErrorText } from "./takeover-panel";

afterEach(cleanup);
let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
});

type D = TakeoverItemView["domains"][number];
const dom = (o: Partial<D> = {}): D => ({ host: "web.example.com", tempCheck: "ok", finalCheck: "pending", cert: "pending", ...o });
const item = (o: Partial<TakeoverItemView> = {}): TakeoverItemView => ({ itemRef: "app:s:web", name: "web", buildMode: "reuse-image", domains: [dom()], ...o });
const view = (status: TakeoverStatus, items: TakeoverItemView[] = [item()], o: Partial<TakeoverView> = {}): TakeoverView => ({ id: "tk1", serverId: "srv1", status, tempPort: null, items, giveBackAvailable: true, createdAt: "2026-11-26T10:00:00Z", finishedAt: null, ...o });

const mount = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <TakeoverPanel serverId="srv1" serverName="olgu-box" opId="op1" />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("TakeoverPanel", () => {
  it("with no takeover it explains that planning changes nothing and offers only to plan", async () => {
    vi.spyOn(api, "listInPlace").mockResolvedValue([]);
    const plan = vi.spyOn(api, "planInPlace").mockResolvedValue(view("PLANNED"));
    mount();
    expect(await screen.findByText(/Planning only reads what Coolify runs/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Test on a temporary address" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan the takeover" }));
    await waitFor(() => expect(plan).toHaveBeenCalledWith({ serverId: "srv1", opId: "op1" }));
    expect(await screen.findByRole("button", { name: "Test on a temporary address" })).toBeTruthy();
  });

  it("shows each app with its domains, checks and certificates, and the apps left out with the reason", async () => {
    vi.spyOn(api, "listInPlace").mockResolvedValue([
      view("SWAPPED", [
        item({ domains: [dom({ finalCheck: "ok", cert: "fallback" })] }),
        item({ itemRef: "app:s:db", name: "db", exclusive: true, domains: [dom({ host: "api.example.com", tempCheck: "pending", finalCheck: "failed", cert: "failed" })] }),
        item({ itemRef: "app:s:old", name: "old", skipped: true, issues: ["volume_unmapped"] }),
      ]),
    ]);
    mount();
    const rows = await screen.findAllByTestId("takeover-item");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("web.example.com")).toBeTruthy();
    expect(within(rows[0]).getByText("Coolify's certificate, for a few minutes")).toBeTruthy();
    expect(within(rows[1]).getByText("Switched, not tested alongside")).toBeTruthy();
    expect(within(rows[1]).getByText("Certificate failed")).toBeTruthy();
    expect(within(rows[2]).getByText("Left out")).toBeTruthy();
    expect(within(rows[2]).getByText(/writes to a volume Tugra's copy of the app does not declare/)).toBeTruthy();
    expect(within(rows[2]).queryByText(/example\.com/)).toBeNull();
    expect(screen.getByTestId("takeover-rollup").textContent).toBe("2 apps (1 left out), 2 domains. Tested: 1. Checked after the switch: 1. New certificates: 0.");
  });

  it("offers to take the ports only after a good test, and asks for the server's name before it does", async () => {
    vi.spyOn(api, "listInPlace").mockResolvedValue([view("TESTING")]);
    const swap = vi.spyOn(api, "swapInPlace").mockResolvedValue(view("SWAPPED"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Take over the ports" }));
    const dialog = await screen.findByRole("dialog");
    const go = within(dialog).getByRole("button", { name: "Take over" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type olgu-box to confirm"), { target: { value: "wrong" } });
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type olgu-box to confirm"), { target: { value: "olgu-box" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(swap).toHaveBeenCalledWith("tk1", "olgu-box"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/Tugra serves the sites now/)).toBeTruthy();
  });

  it("no swap button while a domain failed its test", async () => {
    vi.spyOn(api, "listInPlace").mockResolvedValue([view("TESTING", [item({ domains: [dom({ tempCheck: "failed" })] })])]);
    mount();
    await screen.findByTestId("takeover-item");
    expect(screen.queryByRole("button", { name: "Take over the ports" })).toBeNull();
    expect(screen.getByRole("button", { name: "Test on a temporary address" })).toBeTruthy();
  });

  it("give back is one click plus the typed name, from any started state", async () => {
    vi.spyOn(api, "listInPlace").mockResolvedValue([view("VERIFIED", [item({ domains: [dom({ finalCheck: "ok", cert: "issued" })] })])]);
    const give = vi.spyOn(api, "giveBackInPlace").mockResolvedValue(view("GIVEN_BACK", [item()], { giveBackAvailable: false }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Give back to Coolify" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Type olgu-box to confirm"), { target: { value: "olgu-box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Give back" }));
    await waitFor(() => expect(give).toHaveBeenCalledWith("tk1", "olgu-box"));
    expect(await screen.findByText("Given back to Coolify")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Give back to Coolify" })).toBeNull();
  });

  it("verify is offered while swapped and says there is more to wait for", async () => {
    vi.spyOn(api, "listInPlace").mockResolvedValue([view("SWAPPED", [item({ domains: [dom({ finalCheck: "ok", cert: "fallback" })] })])]);
    const verify = vi.spyOn(api, "verifyInPlace").mockResolvedValue(view("VERIFIED", [item({ domains: [dom({ finalCheck: "ok", cert: "issued" })] })]));
    mount();
    expect(await screen.findByText(/Some domains still wait for a new certificate/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again and get new certificates" }));
    await waitFor(() => expect(verify).toHaveBeenCalledWith("tk1"));
    expect(await screen.findByText("New certificate issued")).toBeTruthy();
  });

  it("a failed step shows its reason in words, never the response text", async () => {
    vi.spyOn(api, "listInPlace").mockResolvedValue([view("FAILED", [item()], { failureCode: "swap_stop_failed" })]);
    mount();
    expect((await screen.findByRole("alert")).textContent).toBe("Coolify's proxy would not stop. Everything was put back.");
  });

  it("a refused call says why through a toast line, with a generic line for a code it does not know", () => {
    const t = (k: string) => (k === "coolifyInPlace.error.takeover_test_failed" ? "A domain failed its test. Fix it and test again." : k === "coolifyInPlace.error.generic" ? "That did not work. Try again." : k);
    expect(takeoverErrorText(t, new ApiError(409, "takeover_test_failed", "takeover_test_failed"))).toBe("A domain failed its test. Fix it and test again.");
    expect(takeoverErrorText(t, new ApiError(500, "SELECT * FROM secrets", "weird_code"))).toBe("That did not work. Try again.");
    expect(takeoverErrorText(t, new Error("boom"))).toBe("That did not work. Try again.");
  });
});
