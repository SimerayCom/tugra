import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { RunInPlaceView, TakeoverItemView } from "@tugra/shared";
import { I18nProvider } from "../../i18n/provider";
import { ConfirmProvider } from "../confirm";
import { api, ApiError } from "../../lib/api";
import { RunDetail } from "./run-detail";
import { mkRun, mkStep } from "./test-fixtures";
import { MIGRATION_RUN_STEP_KEYS } from "../../lib/migration-run";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../import-volume-transfers", () => ({ ImportVolumeTransfers: () => null }));
vi.mock("../cutover-panel", () => ({ CutoverPanel: () => null }));

afterEach(cleanup);
let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <RunDetail id="run12345abcdef" />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const freshClient = () => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
};
beforeEach(() => {
  freshClient();
  vi.spyOn(api, "getMigrationRunEvents").mockResolvedValue({ events: [], lastSeq: 0, hasMore: false });
  vi.spyOn(api, "getMigrationRunReport").mockRejectedValue(new Error("no report"));
  vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue({ imagePins: [], workerMarks: [], warningAcks: [] });
});
afterEach(() => vi.restoreAllMocks());

const FLOW = MIGRATION_RUN_STEP_KEYS.filter((k) => k !== "DECOMMISSION");
const steps = () => FLOW.map((k) => mkStep(k, "PENDING"));
const dom = (host: string, temp: "pending" | "ok" | "failed" = "ok") => ({ host, tempCheck: temp, finalCheck: "pending" as const, cert: "pending" as const });
const item = (o: Partial<TakeoverItemView> & { itemRef: string; name: string }): TakeoverItemView => ({ buildMode: "reuse-image", domains: [dom(`${o.name}.example.com`)], ...o });
const view = (o: Partial<RunInPlaceView> = {}): RunInPlaceView => ({ id: "tk1", status: "TESTING", failureCode: null, pending: 0, verified: false, items: [], ...o });

describe("an in-place run in the run view", () => {
  it("wears the in-place badge in the header, and a copy run does not", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ inPlace: true, topology: "swap-proxy", mode: "takeover", currentStep: "DEPLOY_DARK" }, steps()));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view());
    wrap();
    expect((await screen.findByTestId("in-place-badge")).textContent).toBe("In place");
    cleanup();
    freshClient();
    vi.restoreAllMocks();
    vi.spyOn(api, "getMigrationRunEvents").mockResolvedValue({ events: [], lastSeq: 0, hasMore: false });
    vi.spyOn(api, "getMigrationRunReport").mockRejectedValue(new Error("no report"));
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue({ imagePins: [], workerMarks: [], warningAcks: [] });
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ currentStep: "DEPLOY_DARK" }, steps()));
    const inPlace = vi.spyOn(api, "getRunInPlace");
    wrap();
    await screen.findByText("coolify.example.org → tugra-1");
    expect(screen.queryByTestId("in-place-badge")).toBeNull();
    expect(screen.queryByText("Taken over in place")).toBeNull();
    // a run that is not in place never asks the hub for a takeover
    expect(inPlace).not.toHaveBeenCalled();
  });

  it("says per app whether the image was reused or the app was rebuilt and verified", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ inPlace: true, topology: "swap-proxy", mode: "takeover", currentStep: "VERIFY" }, steps()));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(
      view({
        items: [
          item({ itemRef: "app:s:web", name: "web" }),
          item({ itemRef: "app:s:blog", name: "blog", buildMode: "rebuild-verify" }),
          item({ itemRef: "app:s:shop", name: "shop", buildMode: "rebuild-verify", domains: [dom("shop.example.com", "pending")] }),
          item({ itemRef: "app:s:bad", name: "bad", buildMode: "rebuild-verify", domains: [dom("bad.example.com", "failed")] }),
          item({ itemRef: "app:s:gone", name: "gone", buildMode: "rebuild-verify", skipped: true, issues: ["rebuild_failed"], domains: [] }),
          item({ itemRef: "app:s:data", name: "data", exclusive: true, rebuildDeclined: true }),
          item({ itemRef: "app:s:old", name: "old", skipped: true, issues: ["container_absent"], domains: [] }),
          item({ itemRef: "database:s:pg", name: "pg", kind: "database", domains: [] }),
        ],
      }),
    );
    wrap();
    const rows = await screen.findAllByTestId("in-place-app");
    const byName = Object.fromEntries(rows.map((r) => [within(r).getByRole("strong", {}, ).textContent, r]).filter(Boolean) as Array<[string, HTMLElement]>);
    const outcome = (n: string) => byName[n].getAttribute("data-outcome");
    expect(outcome("web")).toBe("reused");
    expect(outcome("blog")).toBe("rebuilt_verified");
    expect(outcome("shop")).toBe("rebuilding");
    expect(outcome("bad")).toBe("rebuilt_check_failed");
    expect(outcome("gone")).toBe("rebuild_failed");
    expect(outcome("data")).toBe("rebuild_declined");
    expect(outcome("old")).toBe("skipped");
    expect(outcome("pg")).toBe("database");
    expect(within(byName.web).getByText("Reused the image Coolify built")).toBeTruthy();
    expect(within(byName.blog).getByText("Rebuilt with Tugra and verified")).toBeTruthy();
    expect(within(byName.data).getByText(/shares data with Coolify's copy, so it reuses the image/)).toBeTruthy();
    expect(within(byName.gone).getByText("The rebuild with Tugra failed.")).toBeTruthy();
    expect(screen.getByTestId("in-place-rollup").textContent).toBe("7 apps: 1 reuse Coolify's image, 1 rebuilt with Tugra and verified, 1 still being built, 2 with a problem, 1 could not be rebuilt, 1 left out. 1 databases are taken over on their own data.");
  });

  it("shows the takeover's state stage by stage and a failure as stopped, never as progress", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ inPlace: true, topology: "swap-proxy", mode: "takeover", currentStep: "CUTOVER" }, steps()));
    const spy = vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ status: "SWAPPED", items: [item({ itemRef: "app:s:web", name: "web" })] }));
    wrap();
    const stages = await screen.findByTestId("in-place-stages");
    expect(within(stages).getAllByRole("listitem").map((li) => li.getAttribute("data-state"))).toEqual(["done", "done", "current", "todo"]);
    expect(screen.getByText("Handed over")).toBeTruthy();
    cleanup();
    freshClient();
    spy.mockResolvedValue(view({ status: "FAILED", failureCode: "swap_start_failed", items: [] }));
    wrap();
    const failed = await screen.findByTestId("in-place-stages");
    expect(within(failed).getAllByRole("listitem").map((li) => li.getAttribute("data-state"))).toEqual(["stopped", "todo", "todo", "todo"]);
    expect(screen.getByText("Tugra's proxy could not take the ports. Everything was put back.")).toBeTruthy();
  });

  it("puts an in-place note on the steps the takeover changes, and on no other", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ inPlace: true, topology: "swap-proxy", mode: "takeover", currentStep: "DEPLOY_DARK" }, FLOW.map((k) => mkStep(k, k === "DEPLOY_DARK" ? "RUNNING" : "PENDING"))));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ status: "TESTING" }));
    wrap();
    await waitFor(() => expect(screen.getByTestId("in-place-step-note").textContent).toBe("In place: Tugra's proxy runs with no public port and every site was checked on it."));
    expect(screen.getAllByTestId("in-place-step-note")).toHaveLength(1);
  });

  it("says plainly that no takeover exists yet (404), and that it could not be read on an error", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ inPlace: true, topology: "swap-proxy", mode: "takeover" }, steps()));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(null);
    wrap();
    expect((await screen.findByText(/has not been planned yet/)).textContent).toContain("nothing is changed before that");
    cleanup();
    freshClient();
    vi.restoreAllMocks();
    vi.spyOn(api, "getMigrationRunEvents").mockResolvedValue({ events: [], lastSeq: 0, hasMore: false });
    vi.spyOn(api, "getMigrationRunReport").mockRejectedValue(new Error("no report"));
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue({ imagePins: [], workerMarks: [], warningAcks: [] });
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ inPlace: true, topology: "swap-proxy", mode: "takeover" }, steps()));
    vi.spyOn(api, "getRunInPlace").mockRejectedValue(new ApiError(500, "boom"));
    wrap();
    expect(await screen.findByText("The takeover could not be read. Try again.")).toBeTruthy();
  });
});
