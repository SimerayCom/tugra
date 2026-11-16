import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ToastProvider } from "./toast";
import { ConfirmProvider } from "./confirm";
import { EnvCard } from "./env-card";
import { api } from "../lib/api";

// Record every value the card hands to the leave guard, render by render.
const guardCalls: boolean[] = [];
vi.mock("../hooks/useUnsavedChanges", () => ({
  useUnsavedChanges: (dirty: boolean) => { guardCalls.push(dirty); },
}));
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(true) }));

afterEach(() => { cleanup(); guardCalls.length = 0; vi.restoreAllMocks(); });

const wrap = (qc: QueryClient, ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("EnvCard leave guard", () => {
  it("never reports unsaved edits while the loaded env is being seeded into rows", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1", B: "2" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    wrap(qc, <EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("2");
    expect(guardCalls.length).toBeGreaterThan(0);
    expect(guardCalls.every((d) => d === false)).toBe(true);
  });

  it("never reports unsaved edits when the env is already cached on mount", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(["appEnv", "a1"], { A: "1" });
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    wrap(qc, <EnvCard id="a1" canWrite />);
    expect(guardCalls.every((d) => d === false)).toBe(true);
  });

  it("reports unsaved edits once the user changes a seeded row", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    wrap(qc, <EnvCard id="a1" canWrite />);
    fireEvent.change(await screen.findByDisplayValue("1"), { target: { value: "2" } });
    expect(guardCalls[guardCalls.length - 1]).toBe(true);
  });
});
