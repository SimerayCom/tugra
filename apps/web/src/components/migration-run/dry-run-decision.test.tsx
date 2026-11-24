import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { ConfirmProvider } from "../confirm";
import { api } from "../../lib/api";
import { DryRunDecision } from "./dry-run-decision";
import { mkRun, mkStep } from "./test-fixtures";
import type { MigrationRunDryRunItem, MigrationRunStepKey, MigrationRunView } from "../../lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  push.mockReset();
});

const dryRun = (items: Partial<Record<MigrationRunStepKey, MigrationRunDryRunItem[]>>, over: Partial<MigrationRunView> = {}): MigrationRunView => {
  const steps = (Object.entries(items) as Array<[MigrationRunStepKey, MigrationRunDryRunItem[]]>).map(([k, d]) => mkStep(k, "PASSED", { progress: { done: 0, total: d.length, unit: "item", dryRun: d } }));
  return mkRun({ dryRun: true, status: "DRY_RUN_DONE", currentStep: null, allowed: { ...mkRun().allowed, start: true, pause: false, abort: false }, ...over }, steps);
};
const risk = (r: string, items: string[]): MigrationRunDryRunItem => ({ code: "import.risk-warning", level: "warn", params: { risk: r, count: items.length, items } });
const wrap = (run: MigrationRunView, onOpenSafety?: () => void) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <DryRunDecision run={run} onOpenSafety={onOpenSafety} />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
const hints = (warningAcks: string[] = [], over: Record<string, unknown> = {}) => ({ imagePins: [], workerMarks: [], warningAcks, servicePins: [], warningsFixed: [], ...over });

describe("DryRunDecision", () => {
  it("green: says there are no problems and starts the real migration (through the same confirm as promotion)", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    const start = vi.spyOn(api, "startMigrationRun").mockResolvedValue(mkRun({ id: "newrun1" }));
    wrap(dryRun({ IMPORT: [{ code: "import.projection", level: "info", params: { apps: 2, databases: 1, services: 0 } }] }));
    await screen.findByText("No problems found. You can start the real migration.");
    const btn = screen.getByRole("button", { name: "Start migration" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Promote to real run" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("run12345abcdef"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/import/runs/newrun1"));
  });

  it("one card: what moves, data, duration, downtime and the way back", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    wrap(
      dryRun({
        IMPORT: [{ code: "import.projection", level: "info", params: { apps: 2, databases: 1, services: 3 } }],
        DATA_SEED: [{ code: "data-seed.estimate", level: "info", params: { seconds: 120, bytes: 5 * 1024 ** 3, warmSeconds: 600 } }],
      }),
    );
    await screen.findByText("No problems found. You can start the real migration.");
    expect(screen.getByText("2 apps, 1 databases, 3 services")).toBeTruthy();
    expect(screen.getByText("5.0 GiB")).toBeTruthy();
    expect(screen.getByText("About 12 min")).toBeTruthy(); // 600 s warm copy + 120 s window
    expect(screen.getByText("About 2 min")).toBeTruthy();
    expect(screen.getByText(/Your source keeps running untouched/)).toBeTruthy();
  });

  it("the card never invents a figure the dry run did not give", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    wrap(dryRun({ IMPORT: [{ code: "import.projection", level: "info", params: { apps: 1, databases: 0, services: 0 } }] }));
    await screen.findByText("No problems found. You can start the real migration.");
    expect(screen.getByText("Not measured yet")).toBeTruthy();
    expect(screen.getAllByText("Not estimated yet")).toHaveLength(2);
  });

  it("takeover states the point of no return in the way back", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    wrap(dryRun({ IMPORT: [] }, { mode: "takeover" }));
    await screen.findByText(/After it, you can reverse/);
  });

  it("the pin fix opens the safety card in Details through the callback", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    const open = vi.fn();
    wrap(dryRun({ IMPORT: [risk("service.image.floating", ["search"])] }), open);
    fireEvent.click(await screen.findByRole("button", { name: "Pin it in Details" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("a warning the hub cannot store says so and does not hold Start back", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    wrap(dryRun({ IMPORT: [{ code: "Odd Code", level: "warn" }] }));
    await screen.findByText("Nothing to decide here. It does not stop the migration.");
    expect((screen.getByRole("button", { name: "Start migration" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("yellow: each warning carries its fix and Accept and continue, and Start waits until all are settled", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    const save = vi.spyOn(api, "setMigrationRunWarningAcks").mockResolvedValue(hints(["import.risk-warning:app.git.private"]));
    wrap(dryRun({ IMPORT: [risk("app.git.private", ["web"]), risk("service.image.floating", ["search", "cache"])] }), vi.fn());
    await screen.findByText("2 warnings");
    expect((screen.getByRole("button", { name: "Start migration" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Private GitHub repositories need a connected GitHub.")).toBeTruthy();
    expect(screen.getByText("2 items use a floating image tag: search, cache.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect GitHub" }).getAttribute("href")).toBe("/sources");
    expect(screen.getByRole("button", { name: "Pin it in Details" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept and continue: Private GitHub repositories need a connected GitHub." }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("run12345abcdef", { acks: [{ key: "import.risk-warning:app.git.private", accepted: true }] }));
    await screen.findByText("1 warning");
    expect(screen.getByRole("button", { name: /Undo accepting/ })).toBeTruthy();
  });

  it("Accept all settles every warning at once and turns the screen green", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    const keys = ["import.risk-warning:app.git.private", "import.risk-warning:service.image.floating"];
    const save = vi.spyOn(api, "setMigrationRunWarningAcks").mockResolvedValue(hints(keys));
    wrap(dryRun({ IMPORT: [risk("app.git.private", ["web"]), risk("service.image.floating", ["search"])] }));
    await screen.findByText("2 warnings");
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("run12345abcdef", { acks: keys.map((key) => ({ key, accepted: true })) }));
    await screen.findByText("No open problems. 2 warnings accepted or fixed. You can start the real migration.");
    expect((screen.getByRole("button", { name: "Start migration" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("starts from the warnings already accepted on the dry run, and an acceptance can be taken back", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints(["import.risk-warning:app.git.private"]));
    const save = vi.spyOn(api, "setMigrationRunWarningAcks").mockResolvedValue(hints());
    wrap(dryRun({ IMPORT: [risk("app.git.private", ["web"])] }));
    await screen.findByText("No open problems. 1 warnings accepted or fixed. You can start the real migration.");
    fireEvent.click(screen.getByRole("button", { name: /Undo accepting/ }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("run12345abcdef", { acks: [{ key: "import.risk-warning:app.git.private", accepted: false }] }));
    await screen.findByText("1 warning");
  });

  it("a warning nobody wrote a sentence for still shows its own text and can be accepted", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    wrap(dryRun({ DATA_SEED: [{ code: "data-seed.some-new-code", level: "warn", subject: "vol-a" }] }));
    await screen.findByText("1 warning");
    expect(screen.getAllByText(/data seed: some new code/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Accept and continue/ })).toBeTruthy();
  });

  it("red: lists what stops the run with how to fix it, and Start stays off even if warnings were accepted", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints(["data-seed.volume-excluded"]));
    wrap(dryRun({ IMPORT: [{ code: "import.plan-changed", level: "block" }], DATA_SEED: [{ code: "data-seed.volume-excluded", level: "warn", subject: "v" }] }));
    await screen.findByText("1 problem stops the real migration");
    expect(screen.getByText("The source plan changed since you reviewed it.")).toBeTruthy();
    expect(screen.getByText(/Review the plan again and run a new dry run/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the import review" }).getAttribute("href")).toBe("/import");
    expect((screen.getByRole("button", { name: "Start migration" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Start stays off when the hub does not allow it", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    wrap(dryRun({ IMPORT: [] }, { allowed: { ...mkRun().allowed, start: false } }));
    await screen.findByText("No problems found. You can start the real migration.");
    expect((screen.getByRole("button", { name: "Start migration" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("when the accepted list cannot be read the screen still answers, with every warning open", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockRejectedValue(new Error("x"));
    wrap(dryRun({ IMPORT: [risk("app.git.private", ["web"])] }));
    await screen.findByText("1 warning");
  });
});

describe("DryRunDecision: pin to the source version", () => {
  const SVC = "service:src:abc";
  const floating = (seen: string[]): MigrationRunDryRunItem => ({
    code: "import.risk-warning",
    level: "warn",
    params: { risk: "service.image.floating", count: 2, items: ["search"], imageCount: 2, imageItems: [SVC, SVC], imageMembers: ["meili", "web"], images: ["getmeili/meilisearch:latest", "ghcr.io/acme/web"], imageSeen: seen },
  });
  const KEY = "import.risk-warning:service.image.floating";

  it("one click pins every member when the source shows a version for each, and the screen turns green", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    const pin = vi.spyOn(api, "setMigrationRunServicePins").mockResolvedValue(hints([], { warningsFixed: [KEY], servicePins: [] }));
    wrap(dryRun({ IMPORT: [floating(["getmeili/meilisearch:v1.8.0", "ghcr.io/acme/web:2.1.0"])] }));
    await screen.findByText("1 warning");
    fireEvent.click(screen.getByRole("button", { name: "Pin to the source version" }));
    await waitFor(() =>
      expect(pin).toHaveBeenCalledWith("run12345abcdef", {
        pins: [
          { itemRef: SVC, member: "meili", ref: "getmeili/meilisearch:v1.8.0" },
          { itemRef: SVC, member: "web", ref: "ghcr.io/acme/web:2.1.0" },
        ],
      }),
    );
    await screen.findByText("No open problems. 1 warnings accepted or fixed. You can start the real migration.");
    expect(screen.getByText(/Pinned\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Accept and continue/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Start migration" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("without a version from the source it asks for one per member, prefilled where known, and pins a tag or a digest", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    const pin = vi.spyOn(api, "setMigrationRunServicePins").mockResolvedValue(hints());
    wrap(dryRun({ IMPORT: [floating(["getmeili/meilisearch:v1.8.0", ""])] }));
    await screen.findByText("1 warning");
    expect(screen.queryByRole("button", { name: "Pin to the source version" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pin versions" }));
    const meili = screen.getByLabelText("Version for meili") as HTMLInputElement;
    const web = screen.getByLabelText("Version for web") as HTMLInputElement;
    expect(meili.value).toBe("v1.8.0");
    expect(screen.getByText("Source image: ghcr.io/acme/web")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Pin" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // web has no version yet
    fireEvent.change(web, { target: { value: "latest" } });
    expect(screen.getByText("Use a version tag other than latest, or a sha256 digest.")).toBeTruthy();
    expect(submit.disabled).toBe(true);
    fireEvent.change(web, { target: { value: `sha256:${"a".repeat(64)}` } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(pin).toHaveBeenCalledWith("run12345abcdef", {
        pins: [
          { itemRef: SVC, member: "meili", ref: "getmeili/meilisearch:v1.8.0" },
          { itemRef: SVC, member: "web", ref: `ghcr.io/acme/web@sha256:${"a".repeat(64)}` },
        ],
      }),
    );
  });

  it("a warning the hub reports as fixed needs no acceptance; image apps still go to Details", async () => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints([], { warningsFixed: [KEY] }));
    wrap(dryRun({ IMPORT: [floating(["", ""])] }));
    await screen.findByText("No open problems. 1 warnings accepted or fixed. You can start the real migration.");
    expect(screen.queryByRole("button", { name: "Pin versions" })).toBeNull();
    cleanup();
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints());
    const open = vi.fn();
    wrap(dryRun({ PREFLIGHT: [{ code: "preflight.images-unpinned", level: "warn", params: { count: 1, items: ["proxy"], imageCount: 1, imageItems: ["app:s:p"], imageMembers: [""], images: ["img/proxy:latest"], imageSeen: [""] } }] }), open);
    await screen.findByText("1 warning");
    expect(screen.queryByRole("button", { name: "Pin versions" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pin it in Details" }));
    expect(open).toHaveBeenCalled();
  });
});
