import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { DomainCard } from "./domain-card";
import { api } from "../lib/api";

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("DomainCard", () => {
  it("labels the hostname field (was placeholder-only) and gates Save on a valid, changed value", async () => {
    const set = vi.spyOn(api, "setAppDomain").mockResolvedValue({ ok: true });
    wrap(<DomainCard id="a1" domain={null} https={false} />);
    const input = screen.getByLabelText("Hostname");
    expect(input).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true); // empty
    fireEvent.change(input, { target: { value: "app.example.com" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", "app.example.com"));
  });

  it("offers Clear only when a domain is set, and clears to null", async () => {
    const set = vi.spyOn(api, "setAppDomain").mockResolvedValue({ ok: true });
    const { rerender } = wrap(<DomainCard id="a1" domain={null} https={false} />);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    rerender(<QueryClientProvider client={qc}><I18nProvider><DomainCard id="a1" domain="app.example.com" https={false} /></I18nProvider></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", null));
  });

  it("previews the https URL when TLS is on and the hostname is valid", () => {
    wrap(<DomainCard id="a1" domain="app.example.com" https />);
    expect(screen.getByText("https://app.example.com")).toBeTruthy();
  });
});
