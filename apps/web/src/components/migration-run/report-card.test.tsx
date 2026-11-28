import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/provider";
import type { MigrationRunDataIntegrity, MigrationRunReport } from "../../lib/types";
import { ReportBody } from "./report-card";

afterEach(cleanup);

const SHA = "a".repeat(64);
const check = (over: Partial<MigrationRunDataIntegrity> = {}, rows: Partial<MigrationRunDataIntegrity["rows"]> = {}): MigrationRunDataIntegrity => ({
  itemRef: "database:s:main", name: "db-main", engine: "POSTGRES", lane: "stream", bytes: 3 * 1024 ** 3, parts: 24, sha256: SHA,
  rows: { status: "match", mode: "exact", relations: 12, differing: 0, sourceRows: 1234567, targetRows: 1234567, names: [], ...rows },
  ...over,
});
const report = (dataIntegrity?: MigrationRunDataIntegrity[]): MigrationRunReport => ({
  runId: "run-1", generatedAt: "2026-11-25T10:00:00.000Z", status: "COMPLETED", mode: "copy", topology: "two-box", dryRun: false,
  source: { kind: "coolify", host: "src.example.test" }, target: { serverId: "srv1", serverName: "tugra-1" },
  ponrAt: null, window: { estimatedSec: 600, measuredSec: 420 }, steps: [], evidenceSummary: {}, manual: [], items: [],
  ...(dataIntegrity ? { dataIntegrity } : {}),
});
const mount = (r: MigrationRunReport) => render(<I18nProvider><ReportBody report={r} /></I18nProvider>);

describe("ReportBody: data checks", () => {
  it("says the route and the row check in one line per database, with size, parts and the checksum behind More", () => {
    mount(report([check()]));
    const section = screen.getByRole("region", { name: "Data checks" });
    expect(within(section).getByText("db-main")).toBeTruthy();
    expect(within(section).getByText("Checked stream")).toBeTruthy();
    expect(within(section).getByText("Rows match: 12 tables, 1,234,567 rows.")).toBeTruthy();
    expect(within(section).getByText("More")).toBeTruthy();
    expect(within(section).getByText("Size: 3.0 GiB")).toBeTruthy();
    expect(within(section).getByText("Parts: 24")).toBeTruthy();
    expect(within(section).getByText(SHA)).toBeTruthy();
    expect(within(section).getByText(/^Part list checksum/)).toBeTruthy();
  });

  it("names the tables whose rows are missing and does not show a part count for a single dump", () => {
    mount(report([check({ lane: "dump", parts: null }, { status: "mismatch", differing: 2, names: ["public.orders", "public.items"] })]));
    expect(screen.getByText("Rows are missing in 2 of 12 tables: public.orders, public.items.")).toBeTruthy();
    expect(screen.getByText("One dump")).toBeTruthy();
    expect(screen.queryByText(/^Parts:/)).toBeNull();
  });

  it("says when rows were not compared or no checksum was recorded", () => {
    mount(report([check({ sha256: null, bytes: null }, { status: "unverified", relations: null, sourceRows: null, targetRows: null })]));
    expect(screen.getByText("Rows not compared yet.")).toBeTruthy();
    expect(screen.getByText("No checksum was recorded.")).toBeTruthy();
  });

  it("shows nothing for a report without the section (an older hub or no database)", () => {
    mount(report());
    expect(screen.queryByRole("region", { name: "Data checks" })).toBeNull();
    cleanup();
    mount(report([]));
    expect(screen.queryByRole("region", { name: "Data checks" })).toBeNull();
  });
});

describe("ReportBody: the poll counter and the fleet's noise", () => {
  const base = report();
  it("never prints 'attempt N' for a step", () => {
    mount({ ...base, steps: [{ key: "IMPORT", status: "PASSED", attempts: 50, durationSec: 12, code: null }] });
    expect(document.body.textContent).not.toMatch(/attempt/i);
    expect(screen.getByText("12 s")).toBeTruthy();
  });
  it("an in-place report leaves out the fleet's 'skipped by the importer' lines, the evidence counts and the step table", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ kind: "app" as const, name: `other-${i}`, outcome: "skipped" as const, code: "import.task-skipped", evidence: null }));
    const r = { ...base, items: [...items, { kind: "app" as const, name: "mine", outcome: "not-cut-over" as const, code: "cutover.skipped", evidence: null }], steps: [{ key: "IMPORT" as const, status: "PASSED" as const, attempts: 3, durationSec: 4, code: null }] };
    render(<I18nProvider><ReportBody report={r} inPlace /></I18nProvider>);
    expect(screen.queryByText("other-0")).toBeNull();
    expect(screen.getByText("mine")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Hub-verified|Read your apps from Coolify/);
  });
});
