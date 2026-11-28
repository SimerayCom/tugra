import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { RunInPlaceView, TakeoverItemView } from "@tugra/shared";
import { I18nProvider } from "../../i18n/provider";
import { ConfirmProvider } from "../confirm";
import { api, ApiError } from "../../lib/api";
import { RunDetail } from "./run-detail";
import { binding, mkRun, mkStep } from "./test-fixtures";
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

const inPlaceRun = (over: Parameters<typeof mkRun>[0] = {}, st = steps()) => mkRun({ inPlace: true, topology: "swap-proxy", mode: "takeover", ...over }, st);
const text = () => document.body.textContent ?? "";

describe("the page of an in-place run is short", () => {
  it("shows the server, its state in plain words and the apps, and none of the copy run's cards or badges", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ currentStep: "DEPLOY_DARK", status: "RUNNING" }));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ items: [item({ itemRef: "app:s:web", name: "web" })] }));
    wrap();
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toContain("tugra-1");
    expect(screen.getByText("Moving")).toBeTruthy();
    expect(screen.getByTestId("in-place-banner").textContent).toBe("Coolify keeps serving your sites until you approve. One click gives it back.");
    for (const gone of ["Owner inputs", "Safety", "Held workers", "Where each server lands", "Taken over in place", "Point of no return", "Mode", "Topology", "Steps", "Verification report", "Cutover tables"]) expect(screen.queryByText(gone), gone).toBeNull();
    expect(screen.queryByTestId("in-place-badge")).toBeNull();
    expect(text()).not.toMatch(/point of no return|two-box|swap-proxy|abort the run/i);
    // the activity, report and the way back sit behind a closed "Details"
    expect(screen.queryByText("Activity")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Activity")).toBeTruthy();
  });

  it("a move to another server keeps its current content and never asks for a takeover", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ currentStep: "DEPLOY_DARK" }, steps()));
    const inPlace = vi.spyOn(api, "getRunInPlace");
    wrap();
    await screen.findByText("coolify.example.org → tugra-1");
    expect(screen.queryByTestId("in-place-badge")).toBeNull();
    expect(screen.getByText("Owner inputs")).toBeTruthy();
    expect(screen.getByText("Steps")).toBeTruthy();
    expect(inPlace).not.toHaveBeenCalled();
  });

  it("says per app, in one phrase, where it stands, with its domains", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ currentStep: "VERIFY" }));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(
      view({
        items: [
          item({ itemRef: "app:s:web", name: "web" }),
          item({ itemRef: "app:s:shop", name: "shop", domains: [dom("shop.example.com", "pending")] }),
          item({ itemRef: "app:s:bad", name: "bad", domains: [dom("bad.example.com", "failed")] }),
          item({ itemRef: "app:s:blog", name: "blog", buildMode: "rebuild-verify" }),
          item({ itemRef: "app:s:old", name: "old", skipped: true, issues: ["container_absent"], domains: [] }),
          item({ itemRef: "database:s:pg", name: "pg", kind: "database", domains: [] }),
        ],
      }),
    );
    wrap();
    const rows = await screen.findAllByTestId("in-place-app");
    const byName = Object.fromEntries(rows.map((r) => [within(r).getByRole("strong").textContent, r])) as Record<string, HTMLElement>;
    const state = (n: string) => byName[n].getAttribute("data-state");
    expect([state("web"), state("shop"), state("bad"), state("blog"), state("old"), state("pg")]).toEqual(["same", "checking", "needs_look", "same", "left_out", "database"]);
    expect(within(byName.web).getByText("Same as Coolify")).toBeTruthy();
    expect(within(byName.web).getByText("web.example.com")).toBeTruthy();
    expect(within(byName.shop).getByText("Checking...")).toBeTruthy();
    expect(within(byName.bad).getByText("Needs a look")).toBeTruthy();
    expect(within(byName.blog).getByText("Rebuilt with Tugra and verified")).toBeTruthy(); // a rebuild is said as secondary text
    expect(within(byName.web).queryByText(/Reused the image/)).toBeNull(); // the default is not said
    expect(within(byName.old).getByText("Left out of the move")).toBeTruthy();
    expect(within(byName.pg).getByText("Database, taken over on its own data")).toBeTruthy();
    expect(screen.queryByTestId("in-place-rollup")).toBeNull();
  });

  it("shows why a domain differs and what Coolify and Tugra each answered, side by side, from the hub's check", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ currentStep: "DEPLOY_DARK", status: "FAILED", nextAction: { kind: "failed", stepKey: "DEPLOY_DARK", code: "step.failed", since: "2026-11-16T10:00:00.000Z" } }));
    const bad = { ...dom("app.example.com", "failed"), check: { reason: "status_differs" as const, coolify: { status: 200, bytes: 5120, location: null }, tugra: { status: 302, bytes: 0, location: "https://app.example.com/login" } } };
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ items: [item({ itemRef: "app:s:a", name: "app", domains: [bad] })] }));
    wrap();
    const ev = await screen.findByTestId("in-place-evidence");
    expect(within(ev).getByTestId("in-place-reason").textContent).toBe("The two answer with a different status.");
    expect(within(ev).getByText("Coolify")).toBeTruthy();
    expect(within(ev).getByText("Tugra")).toBeTruthy();
    expect(within(ev).getByText("Answer 200")).toBeTruthy();
    expect(within(ev).getByText("Answer 302")).toBeTruthy();
    expect(within(ev).getByText("Sends visitors to https://app.example.com/login")).toBeTruthy();
  });

  it("a domain whose app never came up says so and shows 'No answer' for the side that did not answer", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ currentStep: "DEPLOY_DARK" }));
    const bad = { ...dom("app.example.com", "pending"), check: { reason: "not_ready" as const, coolify: { status: 200, bytes: 10, location: null }, tugra: null } };
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ items: [item({ itemRef: "app:s:a", name: "app", domains: [bad] })] }));
    wrap();
    const ev = await screen.findByTestId("in-place-evidence");
    expect(within(ev).getByTestId("in-place-reason").textContent).toBe("The app's container is not up yet.");
    expect(within(ev).getByText("No answer")).toBeTruthy();
    expect(within(ev).getByText("Answer 200")).toBeTruthy();
  });

  it("a domain that passed draws no evidence", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ currentStep: "VERIFY" }));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ items: [item({ itemRef: "a", name: "a" })] }));
    wrap();
    await screen.findByTestId("in-place-app");
    expect(screen.queryByTestId("in-place-evidence")).toBeNull();
  });

  it("an app carries its site's favicon from the app id the hub sends, and a database its brand from the icon key", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ currentStep: "VERIFY" }));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ items: [item({ itemRef: "a", name: "shop", appId: "app-9" }), item({ itemRef: "d", name: "db", kind: "database", iconKey: "postgresql", domains: [] })] }));
    wrap();
    const rows = await screen.findAllByTestId("in-place-app");
    expect(rows[0].querySelector("img")?.getAttribute("src")).toMatch(/\/apps\/app-9\/favicon\?v=shop\.example\.com/);
    expect(rows[1].querySelector("svg, img")).toBeTruthy();
  });

  it("after the switch an app is 'Live on Tugra' with a certificate, or still getting it", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ currentStep: "CUTOVER" }));
    const live = { host: "a.example.com", tempCheck: "ok" as const, finalCheck: "ok" as const, cert: "issued" as const };
    const waiting = { host: "b.example.com", tempCheck: "ok" as const, finalCheck: "ok" as const, cert: "pending" as const };
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ status: "SWAPPED", items: [item({ itemRef: "app:s:a", name: "a", domains: [live] }), item({ itemRef: "app:s:b", name: "b", domains: [waiting] })] }));
    wrap();
    expect(await screen.findByText("Live on Tugra, certificate issued")).toBeTruthy();
    expect(screen.getByText("Live on Tugra, certificate on its way")).toBeTruthy();
  });

  it("folds a long list behind 'Show all N'", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ currentStep: "VERIFY" }));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ items: Array.from({ length: 9 }, (_, i) => item({ itemRef: `app:s:a${i}`, name: `a${i}` })) }));
    wrap();
    expect(await screen.findAllByTestId("in-place-app")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Show all 9" }));
    expect(screen.getAllByTestId("in-place-app")).toHaveLength(9);
  });

  it("says plainly that no apps are read yet (404), and that the takeover could not be read on an error", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun());
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(null);
    wrap();
    expect((await screen.findByText(/Your apps appear here once Tugra has read them/)).textContent).toContain("Nothing is changed before that");
    cleanup();
    freshClient();
    vi.restoreAllMocks();
    vi.spyOn(api, "getMigrationRunEvents").mockResolvedValue({ events: [], lastSeq: 0, hasMore: false });
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun());
    vi.spyOn(api, "getRunInPlace").mockRejectedValue(new ApiError(500, "boom"));
    wrap();
    expect(await screen.findByText("The takeover could not be read. Try again.")).toBeTruthy();
  });
});

describe("the one card of an in-place run", () => {
  it("a failed test names the host, offers one primary 'Test again' and Give Coolify back, and says nothing was lost", async () => {
    const failed = steps().map((s) => (s.key === "DEPLOY_DARK" ? mkStep("DEPLOY_DARK", "FAILED", { lastError: "deploy-dark.inplace-test-failed", lastErrorParams: { host: "app.example.com", app: "web" }, allowed: { ...s.allowed, retry: true } }) : s));
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ status: "FAILED", currentStep: "DEPLOY_DARK", nextAction: { kind: "failed", stepKey: "DEPLOY_DARK", code: "step.failed", since: "2026-11-16T10:00:00.000Z" } }, failed));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ status: "TESTING" }));
    const retry = vi.spyOn(api, "retryMigrationRunStep").mockResolvedValue(inPlaceRun({ status: "RUNNING" }));
    wrap();
    const card = (await screen.findByTestId("in-place-next-heading")).closest(".tg-card") as HTMLElement;
    expect(within(card).getByText("Something needs a look")).toBeTruthy();
    expect(card.textContent).toMatch(/app\.example\.com does not answer through Tugra/);
    await waitFor(() => expect(card.textContent).toMatch(/Nothing was lost: Coolify still serves your sites\./));
    expect(within(card).queryByText("A failure")).toBeNull(); // the technical kind label is gone
    expect(within(card).queryByText(/since/)).toBeNull();
    expect(within(card).getByRole("button", { name: "Give Coolify back" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Test again" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("run12345abcdef", "DEPLOY_DARK"));
  });

  it("Give Coolify back is one short question, then the run's abort", async () => {
    const failed = steps().map((s) => (s.key === "CUTOVER" ? mkStep("CUTOVER", "FAILED", { lastError: "cutover.inplace-certs-pending", allowed: { ...s.allowed, retry: true } }) : s));
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ status: "FAILED", currentStep: "CUTOVER", nextAction: { kind: "failed", stepKey: "CUTOVER", code: "step.failed", since: "2026-11-16T10:00:00.000Z" } }, failed));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ status: "SWAPPED" }));
    const abort = vi.spyOn(api, "abortMigrationRun").mockResolvedValue(inPlaceRun({ status: "ABORTING" }));
    wrap();
    expect((await screen.findByText(/Your sites stay up while this is sorted out/)).textContent).toContain("give Coolify back");
    fireEvent.click(screen.getByRole("button", { name: "Give Coolify back" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Nothing is lost/);
    expect(dialog.querySelector("input")).toBeNull(); // no typed name
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Coolify back" }));
    await waitFor(() => expect(abort).toHaveBeenCalledWith("run12345abcdef", { confirmName: "run12345abcdef" }));
  });

  it("the go-ahead is three facts and one button; the typed names are filled in after one short question", async () => {
    const waiting = steps().map((s) => (s.key === "VERIFY" ? mkStep("VERIFY", "WAITING_APPROVAL") : mkStep(s.key, ["PREFLIGHT", "IMPORT", "REMAP_ENV", "DEPLOY_DARK"].includes(s.key) ? "PASSED" : "PENDING")));
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      inPlaceRun({ status: "WAITING", currentStep: "VERIFY", nextAction: { kind: "approval", stepKey: "VERIFY", code: "verify.review", since: "2026-11-16T10:00:00.000Z", approval: binding({ ponr: true, confirm: "target-server+source-host", ttlSec: 1800, review: { checks: 12, passed: 12, hosts: 12 } }) } }, waiting),
    );
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ items: [item({ itemRef: "a", name: "a" }), item({ itemRef: "b", name: "b" })] }));
    const approve = vi.spyOn(api, "approveMigrationRunStep").mockResolvedValue(inPlaceRun({ status: "RUNNING" }));
    wrap();
    expect((await screen.findByTestId("in-place-sites-same")).textContent).toBe("All 2 sites answer the same through Tugra as through Coolify.");
    expect(text()).not.toMatch(/Point of no return|Approve and pass/);
    expect(screen.queryByRole("textbox")).toBeNull(); // nothing to type
    expect(screen.queryByText("checks")).toBeNull(); // the review table is gone
    fireEvent.click(screen.getByRole("button", { name: "Take over tugra-1" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Take over tugra-1 now\?/);
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("run12345abcdef", "VERIFY", expect.objectContaining({ confirmName: "tugra-1 coolify.example.org", boundHash: expect.any(String) })));
  });

  it("an app left out is listed in words and acknowledged by the same one button", async () => {
    const waiting = steps().map((s) => (s.key === "VERIFY" ? mkStep("VERIFY", "WAITING_APPROVAL", { gate: { passed: false, checks: [{ id: "verify.app-left-out", status: "warn", code: "verify.inplace-app-left-out", subject: "old", params: { app: "old" } }] } as never }) : mkStep(s.key, "PENDING")));
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      inPlaceRun({ status: "WAITING", currentStep: "VERIFY", nextAction: { kind: "approval", stepKey: "VERIFY", code: "verify.review", since: "2026-11-16T10:00:00.000Z", approval: binding({ confirm: "none", ackable: ["verify.app-left-out"], requiredAcks: ["verify.app-left-out"] }) } }, waiting),
    );
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view());
    const approve = vi.spyOn(api, "approveMigrationRunStep").mockResolvedValue(inPlaceRun({ status: "RUNNING" }));
    wrap();
    expect((await screen.findByTestId("in-place-asks")).querySelectorAll("li")).toHaveLength(1);
    expect(text()).not.toMatch(/continue without/);
    expect(text()).toMatch(/Left out of the move, Coolify keeps running them/);
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Take over tugra-1" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("run12345abcdef", "VERIFY", expect.objectContaining({ acks: ["verify.app-left-out"] })));
  });

  it("an approval that is not the take-over says plainly what is confirmed, and never prints a raw check id", async () => {
    const waiting = steps().map((s) => (s.key === "IMPORT" ? mkStep("IMPORT", "WAITING_APPROVAL") : s));
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      inPlaceRun({ status: "WAITING", currentStep: "IMPORT", nextAction: { kind: "approval", stepKey: "IMPORT", code: "import.review", since: "2026-11-16T10:00:00.000Z", approval: binding({ confirm: "none", ackable: ["import.mystery-check"], requiredAcks: ["import.mystery-check"] }) } }, waiting),
    );
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view());
    wrap();
    const asks = await screen.findByTestId("in-place-asks");
    expect(asks.textContent).toBe("A finding you need to confirm");
    expect(text()).toMatch(/You confirm these to continue:/);
    expect(text()).not.toMatch(/import\.mystery-check|continue without/);
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("a queued run says it is ready, with one sentence and Start inside the card (and not in the header)", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ status: "QUEUED", currentStep: null, allowed: { ...mkRun({}, steps()).allowed, start: true }, nextAction: { kind: "engine", stepKey: null, code: "run.queued", since: "2026-11-16T10:00:00.000Z" } }));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(null);
    const start = vi.spyOn(api, "startMigrationRun").mockResolvedValue(inPlaceRun({ status: "RUNNING" }));
    wrap();
    const heading = await screen.findByTestId("in-place-next-heading");
    expect(heading.textContent).toBe("Ready to start");
    const card = heading.closest(".tg-card") as HTMLElement;
    expect(within(card).getByTestId("in-place-ready").textContent).toMatch(/Nothing on your server changes yet/);
    expect(within(card).queryByText("Working on it")).toBeNull();
    expect(card.querySelector('[aria-busy="true"], .tg-spin')).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Start/ })).toHaveLength(1);
    fireEvent.click(within(card).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("run12345abcdef"));
  });

  it("a missing certificate email says where to set it and offers check again; no hint about Coolify while the takeover is unread", async () => {
    const blocked = steps().map((s) =>
      s.key === "CUTOVER"
        ? mkStep("CUTOVER", "PENDING", { gate: { passed: false, checks: [{ id: "cutover.acme-email", status: "unknown", code: "cutover.acme-email", ownerInput: "acmeEmail" }] } as never, allowed: { ...s.allowed, retry: true } })
        : s,
    );
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ status: "WAITING", currentStep: "CUTOVER", nextAction: { kind: "gate", stepKey: "CUTOVER", code: "step.gate-blocked", since: "2026-11-16T10:00:00.000Z" } }, blocked));
    vi.spyOn(api, "getRunInPlace").mockRejectedValue(new ApiError(500, "boom"));
    wrap();
    const heading = await screen.findByTestId("in-place-next-heading");
    const card = heading.closest(".tg-card") as HTMLElement;
    expect(card.textContent).toMatch(/no email address for its certificates/);
    expect(within(card).getByRole("link", { name: "Open the server" }).getAttribute("href")).toBe("/servers/srv1");
    expect(within(card).getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(card.textContent).not.toMatch(/Nothing was lost/);
  });

  it("watching: the window is reassurance, with the time left, and nothing is asked", async () => {
    const soon = new Date(Date.now() + 24 * 60_000).toISOString();
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ status: "WAITING", currentStep: "OBSERVE", nextAction: { kind: "timer", stepKey: "OBSERVE", code: "observe.window-open", since: "2026-11-16T10:00:00.000Z", notBefore: soon } }));
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ status: "VERIFIED", verified: true }));
    wrap();
    expect((await screen.findByTestId("in-place-next-heading")).textContent).toBe("Watching your sites");
    expect(screen.getByText("Watching your sites, nothing needed from you. You can close this page.")).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toMatch(/remaining/);
  });

  it("when it is over: one sentence of what was moved and one button to bring the next server", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ status: "COMPLETED", currentStep: null, finishedAt: "2026-11-16T10:30:00.000Z", campaign: "Moving off Coolify", nextAction: { kind: "none", stepKey: null, code: "run.completed", since: "2026-11-16T10:30:00.000Z" } }));
    const done = { host: "a.example.com", tempCheck: "ok" as const, finalCheck: "ok" as const, cert: "issued" as const };
    vi.spyOn(api, "getRunInPlace").mockResolvedValue(view({ status: "VERIFIED", verified: true, items: [item({ itemRef: "a", name: "a", domains: [done, { ...done, host: "b.example.com" }] })] }));
    wrap();
    const card = await screen.findByTestId("in-place-done");
    await waitFor(() => expect(card.textContent).toContain("2 sites answer like before and have a certificate."));
    expect(within(card).getByRole("link", { name: "Move another server" }).getAttribute("href")).toBe("/import/move-off-coolify");
    expect(within(card).getByRole("link", { name: "Back to the move" })).toBeTruthy();
    expect(screen.getByText("Moved", { selector: "h2" })).toBeTruthy();
  });
});
