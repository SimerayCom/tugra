import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ImportWizard } from "./import-wizard";
import { api } from "../lib/api";
import type { ImportPlan } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

const plan: ImportPlan = {
  sourceKind: "coolify",
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: ["1 service needs a read:sensitive token"],
  totals: { apps: 1, databases: 0, volumes: 0, blockers: 1 },
  items: [
    { itemRef: "app:srv:web", kind: "app", name: "web-app", proposed: {}, risks: [], dependsOn: [] },
    { itemRef: "app:srv:api", kind: "app", name: "api-blocked", proposed: {}, risks: [{ level: "blocker", code: "x", message: "nothing to deploy" }], dependsOn: [] },
  ],
};

describe("ImportWizard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team One" }] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("connects then renders the secret-free preview (counts, item names, warnings)", async () => {
    const connect = vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    const planSpy = vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    wrap(<ImportWizard />);

    await screen.findByRole("option", { name: "Team One" });
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));

    await screen.findByText("Import preview");
    expect(connect).toHaveBeenCalledWith({ sourceKind: "coolify", teamId: "t1", baseUrl: "https://coolify.example.com", token: "tok" });
    expect(planSpy).toHaveBeenCalledWith({ sourceKind: "coolify", sessionId: "s1" });
    expect(screen.getByText("web-app")).toBeTruthy();
    expect(screen.getByText("nothing to deploy")).toBeTruthy(); // the blocker risk is surfaced
    expect(screen.getByText(/read:sensitive/)).toBeTruthy(); // the warning is surfaced
  });

  it("keeps the connect button disabled until url + token are filled", async () => {
    wrap(<ImportWizard />);
    await screen.findByRole("option", { name: "Team One" });
    const btn = screen.getByRole("button", { name: "Connect & preview" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
