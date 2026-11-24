import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import type { MigrationRunView, VerificationReport, VerificationView } from "../../lib/types";

vi.mock("../toast", () => ({ useToast: () => vi.fn() }));

import { VerifyReportCard } from "./verify-report-card";

const sample = (status: number | null, title: string | null = "Home") => ({ status, hash: "h", bytes: 1, title, location: null, truncated: false, error: null });
const report = (over: Partial<VerificationReport> = {}): VerificationReport => ({
  runId: "r1", at: "2026-11-24T10:00:00Z", state: "match", counts: { checked: 2, same: 2, similar: 0, differs: 0, unknown: 0 },
  pages: [{ host: "app.example.com", path: "/", source: sample(200), target: sample(200), verdict: "same", code: "same-content" }],
  databases: [], volumes: [], env: [], previewHosts: ["app.example.com"], ...over,
});
const view = (r: VerificationReport | null, previews: VerificationView["previews"] = []): VerificationView => ({ report: r, previews });
const run = { id: "r1", opId: "op1", dryRun: false } as unknown as MigrationRunView;

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <I18nProvider><VerifyReportCard run={run} /></I18nProvider>
    </QueryClientProvider>,
  );

afterEach(() => { vi.restoreAllMocks(); cleanup(); });
beforeEach(() => { vi.spyOn(api, "getMigrationRunVerification").mockResolvedValue(view(null)); });

describe("VerifyReportCard", () => {
  it("asks for a first comparison when none ran", async () => {
    show();
    expect(await screen.findByText(/Not compared yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare now" })).toBeTruthy();
  });

  it("shows 'Source and target match' and hides matching pages behind a toggle", async () => {
    vi.spyOn(api, "getMigrationRunVerification").mockResolvedValue(view(report()));
    show();
    expect(await screen.findByText("Source and target match")).toBeTruthy();
    expect(screen.getByText("Show 1 matching")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare again" })).toBeTruthy();
  });

  it("lists the differences side by side, with the verdict in words", async () => {
    vi.spyOn(api, "getMigrationRunVerification").mockResolvedValue(
      view(report({
        state: "differences", counts: { checked: 4, same: 1, similar: 0, differs: 3, unknown: 0 },
        pages: [{ host: "app.example.com", path: "/pricing", source: sample(200, "Pricing"), target: sample(502, null), verdict: "differs", code: "status" }],
        databases: [{ itemRef: "d", name: "main", engine: "POSTGRES", verdict: "differs", code: "x", sourceRows: 15, targetRows: 14, tables: [{ name: "orders", source: 5, target: 4 }] }],
        env: [{ itemRef: "a", name: "api", verdict: "differs", code: "keys-missing", targetKeys: 3, missing: [{ key: "STRIPE_KEY", reason: "unresolved" }] }],
      })),
    );
    show();
    expect(await screen.findByText("3 differences found")).toBeTruthy();
    expect(screen.getByText("app.example.com/pricing")).toBeTruthy();
    expect(screen.getByText("Status 502")).toBeTruthy();
    expect(screen.getByText("Different status")).toBeTruthy();
    expect(screen.getByText("orders: 5 → 4")).toBeTruthy();
    expect(screen.getByText("Missing on the target: STRIPE_KEY")).toBeTruthy();
    expect(screen.getAllByText("Differs").length).toBeGreaterThan(0);
  });

  it("never reads unknown as a match", async () => {
    vi.spyOn(api, "getMigrationRunVerification").mockResolvedValue(view(report({ state: "incomplete", counts: { checked: 2, same: 1, similar: 0, differs: 0, unknown: 1 } })));
    show();
    expect(await screen.findByText("Not everything could be checked")).toBeTruthy();
    expect(screen.queryByText("Source and target match")).toBeNull();
  });

  it("runs a comparison and shows the preview link when the app has one", async () => {
    vi.spyOn(api, "getMigrationRunVerification").mockResolvedValue(view(null, [{ host: "app.example.com", url: "https://api-ab12.203-0-113-7.sslip.io" }]));
    const go = vi.spyOn(api, "runMigrationRunVerification").mockResolvedValue(view(report(), [{ host: "app.example.com", url: "https://api-ab12.203-0-113-7.sslip.io" }]));
    show();
    const link = await screen.findByRole("link", { name: /Open the new copy/ });
    expect(link.getAttribute("href")).toBe("https://api-ab12.203-0-113-7.sslip.io");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(screen.getByRole("button", { name: "Compare now" }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("r1"));
    expect(await screen.findByText("Source and target match")).toBeTruthy();
  });
});
