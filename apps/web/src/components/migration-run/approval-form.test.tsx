import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import { subscribeToast } from "../../lib/toast-bus";
import { ApprovalForm } from "./approval-form";
import { HASH, HASH2, binding, mkRun } from "./test-fixtures";
import type { MigrationRunApprovalBinding, MigrationRunGate } from "../../lib/types";

afterEach(cleanup);
let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => vi.restoreAllMocks());

const gate: MigrationRunGate = { passed: false, checks: [{ id: "env-gap", status: "warn", code: "verify.env-gap", subject: "web", ackable: true }] };

function mount(b: MigrationRunApprovalBinding, run = mkRun()) {
  const ui = (bd: MigrationRunApprovalBinding) => (
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ApprovalForm run={run} stepKey="VERIFY" binding={bd} gate={gate} />
      </I18nProvider>
    </QueryClientProvider>
  );
  const r = render(ui(b));
  return { rerender: (bd: MigrationRunApprovalBinding) => r.rerender(ui(bd)) };
}

describe("ApprovalForm", () => {
  it("shows what is being approved and keeps Approve disabled until the typed name matches", async () => {
    const approve = vi.spyOn(api, "approveMigrationRunStep").mockResolvedValue(mkRun());
    mount(binding({ confirm: "target-server", review: { statefulHosts: ["db.example.org"], windowEstimateSec: 600 } }));
    expect(screen.getByText("Stateful hosts")).toBeTruthy();
    expect(screen.getByText("db.example.org")).toBeTruthy();
    expect(screen.getByText("10 min")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const input = screen.getByLabelText("Type tugra-1 to confirm");
    fireEvent.change(input, { target: { value: "tugra" } });
    expect(btn.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "tugra-1" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(approve).toHaveBeenCalledWith("run12345abcdef", "VERIFY", { boundHash: HASH, acks: [], confirmName: "tugra-1" }));
  });

  it("requires the required acknowledgements and sends them with the bound hash", async () => {
    const approve = vi.spyOn(api, "approveMigrationRunStep").mockResolvedValue(mkRun());
    mount(binding({ ackable: ["env-gap"], requiredAcks: ["env-gap"] }));
    const btn = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText("(required)")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(approve).toHaveBeenCalledWith("run12345abcdef", "VERIFY", { boundHash: HASH, acks: ["env-gap"] }));
  });

  it("locks the form when what was reviewed changed, until the operator reviews the new state", async () => {
    const approve = vi.spyOn(api, "approveMigrationRunStep").mockResolvedValue(mkRun());
    const { rerender } = mount(binding({ ackable: ["env-gap"], requiredAcks: ["env-gap"] }));
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);

    // The evidence moved on while the form was open: the hash the hub now expects differs.
    rerender(binding({ inputHash: HASH2, ackable: ["env-gap"], requiredAcks: ["env-gap"] }));
    expect(screen.getByRole("alert").textContent).toContain("has changed");
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Review the new state" }));
    // Acks were cleared: the operator must accept again, and the new hash is what gets sent.
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("run12345abcdef", "VERIFY", { boundHash: HASH2, acks: ["env-gap"] }));
  });

  it("point of no return: loud warning, data-risk acknowledgement, expiry, both names for a takeover", async () => {
    const approve = vi.spyOn(api, "approveMigrationRunStep").mockResolvedValue(mkRun());
    mount(binding({ ponr: true, confirm: "target-server+source-host", requiresDataRisk: true, ttlSec: 1800 }));
    expect(screen.getByText("Point of no return")).toBeTruthy();
    expect(screen.getByText(/valid for 30 minutes/)).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Approve and pass the point of no return" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type tugra-1 to confirm"), { target: { value: "tugra-1" } });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type coolify.example.org to confirm"), { target: { value: "coolify.example.org" } });
    expect(btn.disabled).toBe(true); // data risk not acknowledged
    fireEvent.click(screen.getByRole("checkbox", { name: /stateful data may be lost/ }));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith("run12345abcdef", "VERIFY", { boundHash: HASH, acks: [], confirmName: "tugra-1 coolify.example.org", acceptDataRisk: true }),
    );
  });

  it("cannot confirm when the hub does not know a needed name", () => {
    mount(binding({ confirm: "source-host" }), mkRun({ sourceHost: null }));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/not known to the hub/)).toBeTruthy();
  });

  it("surfaces a hub refusal as a localized toast and keeps the form usable", async () => {
    vi.spyOn(api, "approveMigrationRunStep").mockRejectedValue(new Error("409 approval-stale"));
    const toasts: string[] = [];
    const unsub = subscribeToast((m) => toasts.push(m.message));
    mount(binding());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(toasts).toContain("What you approved no longer matches the current state. Review it again."));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
    unsub();
  });
});
