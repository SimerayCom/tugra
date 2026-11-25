import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { ProjectMoveView } from "@tugra/shared";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError, type ProjectMovePreviewView } from "../lib/api";
import type { ServerView } from "../lib/types";
import { ConfirmProvider } from "./confirm";
import { ProjectMovePanel } from "./project-move-panel";

afterEach(cleanup);

const servers = [
  { id: "s1", name: "old-box", teamId: "t1", status: "ONLINE" },
  { id: "s2", name: "new-box", teamId: "t1", status: "ONLINE" },
  { id: "s3", name: "down-box", teamId: "t1", status: "OFFLINE" },
] as unknown as ServerView[];

const PREVIEW: ProjectMovePreviewView = {
  projectName: "Acme",
  sourceServerId: "s1",
  targetServerId: "s2",
  items: [
    { kind: "database", refId: "d1", name: "main-db", configOnly: false },
    { kind: "application", refId: "a1", name: "web", configOnly: false },
  ],
  blockers: [],
  warnings: [{ code: "app_redeploy_after_relink", ref: "web" }],
};

const move = (over: Partial<ProjectMoveView> = {}): ProjectMoveView => ({
  id: "m1", projectId: "p1", sourceServerId: "s1", targetServerId: "s2", phase: "MOVING",
  items: [
    { kind: "database", refId: "d1", name: "main-db", childId: "c", phase: "moved", tempAddress: null },
    { kind: "application", refId: "a1", name: "web", childId: "mv", phase: "moving", tempAddress: null },
  ],
  retainDays: 7, archiveUntil: null, failureCode: null, report: null, createdAt: "2026-11-26T00:00:00Z", finishedAt: null, ...over,
});

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.restoreAllMocks();
  vi.spyOn(api, "listServers").mockResolvedValue(servers);
  vi.spyOn(api, "projectMoveList").mockResolvedValue([]);
});
const show = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <ProjectMovePanel projectId="p1" projectName="Acme" teamId="t1" excludeServerNames={["old-box"]} />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
const choose = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Move to another server" }));
  const select = await screen.findByRole("combobox", { name: "Move to" });
  await waitFor(() => expect(within(select).getAllByRole("option").map((o) => o.textContent)).toContain("new-box"));
  fireEvent.change(select, { target: { value: "s2" } });
};

describe("ProjectMovePanel: before a move", () => {
  it("offers only the team's online servers other than the one the project is on", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Move to another server" }));
    const select = await screen.findByRole("combobox", { name: "Move to" });
    await waitFor(() => expect(within(select).getAllByRole("option").map((o) => o.textContent)).toContain("new-box"));
    const names = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(names).not.toContain("old-box");
    expect(names).not.toContain("down-box");
  });

  it("previews what moves and what is worth knowing; nothing starts yet", async () => {
    const preview = vi.spyOn(api, "projectMovePreview").mockResolvedValue(PREVIEW);
    const start = vi.spyOn(api, "projectMoveStart");
    show();
    await choose();
    fireEvent.click(screen.getByRole("button", { name: "Check what will move" }));
    await screen.findByText("Nothing stops this move.");
    expect(preview).toHaveBeenCalledWith({ projectId: "p1", targetServerId: "s2", acknowledge: {} });
    expect(screen.getByText("main-db")).toBeTruthy();
    expect(screen.getByText("web is redeployed after it is linked to its new database.")).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });

  it("a blocker is shown in words and keeps the start disabled", async () => {
    vi.spyOn(api, "projectMovePreview").mockResolvedValue({ ...PREVIEW, blockers: [{ code: "db_needs_s3_destination", ref: "main-db" }, { code: "app_preflight_failed", ref: "web", codes: ["target_volume_exists"] }] });
    show();
    await choose();
    fireEvent.click(screen.getByRole("button", { name: "Check what will move" }));
    await screen.findByText("This cannot start yet");
    expect(screen.getByText("A database needs a backup destination (S3) that both servers can reach.")).toBeTruthy();
    expect(screen.getByText("An app cannot move yet: target_volume_exists")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start the move" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("starting needs the project's name typed, then sends the choices", async () => {
    vi.spyOn(api, "projectMovePreview").mockResolvedValue(PREVIEW);
    const start = vi.spyOn(api, "projectMoveStart").mockResolvedValue({ moveId: "m1", phase: "QUEUED" });
    show();
    await choose();
    fireEvent.click(screen.getByRole("button", { name: "Check what will move" }));
    await screen.findByText("Nothing stops this move.");
    fireEvent.click(screen.getByRole("checkbox", { name: "Point the DNS records at the new server too" }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: "Start the move" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/moves the project to new-box\. The old copy stays for 14 days/)).toBeTruthy();
    const go = within(dialog).getByRole("button", { name: "Start the move" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Acme" } });
    fireEvent.click(go);
    await waitFor(() => expect(start).toHaveBeenCalledWith({ projectId: "p1", targetServerId: "s2", acknowledge: {}, repointDns: true, retainDays: 14, confirmName: "Acme" }));
  });

  it("a start the hub refuses shows the blockers it sent", async () => {
    vi.spyOn(api, "projectMovePreview").mockResolvedValue(PREVIEW);
    vi.spyOn(api, "projectMoveStart").mockRejectedValue(new ApiError(409, "x", "preflight_failed", { blockers: [{ code: "agent_offline_target", ref: "s2" }] }));
    show();
    await choose();
    fireEvent.click(screen.getByRole("button", { name: "Check what will move" }));
    await screen.findByText("Nothing stops this move.");
    fireEvent.click(screen.getByRole("button", { name: "Start the move" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Acme" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start the move" }));
    await screen.findByText("The agent on the target server is offline.");
  });
});

describe("ProjectMovePanel: a move in progress and after it", () => {
  it("shows each item's step and the temporary address; no new move can start; cancel is offered before the cut-over", async () => {
    vi.spyOn(api, "projectMoveList").mockResolvedValue([move({ items: [{ kind: "application", refId: "a1", name: "web", childId: "mv", phase: "moved", tempAddress: "web.5-6-7-8.sslip.io" }, { kind: "database", refId: "d1", name: "main-db", childId: null, phase: "copying", tempAddress: null }] })]);
    const cancel = vi.spyOn(api, "projectMoveCancel").mockResolvedValue({ ok: true });
    show();
    await screen.findByText("Moving");
    expect(screen.getByText("Answers at web.5-6-7-8.sslip.io until DNS changes")).toBeTruthy();
    expect(screen.getByText("Copying data")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to another server" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel the move" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("m1"));
  });

  it("no cancel once verifying", async () => {
    vi.spyOn(api, "projectMoveList").mockResolvedValue([move({ phase: "VERIFYING" })]);
    show();
    await screen.findByText("Verifying");
    expect(screen.queryByRole("button", { name: "Cancel the move" })).toBeNull();
  });

  it("a finished move shows the report, the DNS step, the safety date, and removing the old copy asks first", async () => {
    vi.spyOn(api, "projectMoveList").mockResolvedValue([
      move({
        phase: "COMPLETED",
        archiveUntil: "2026-12-03T00:00:00Z",
        report: {
          checks: [{ code: "app_running", itemRef: "a1", name: "web", ok: true }, { code: "db_restored", itemRef: "d1", name: "main-db", ok: true }],
          dns: [{ hostname: "web.example.com", targetIp: "5.6.7.8", repointed: false }],
          warnings: ["pitr_not_carried:main-db"],
        },
      }),
    ]);
    const purge = vi.spyOn(api, "projectMovePurge").mockResolvedValue({ removed: 1, kept: 0 });
    show();
    await screen.findByText("Done");
    expect(screen.getByText("The app is running on the new server")).toBeTruthy();
    expect(screen.getByText("The data was restored")).toBeTruthy();
    expect(screen.getByText("Point web.example.com at 5.6.7.8")).toBeTruthy();
    expect(screen.getByText("main-db: point-in-time recovery is not carried to the new database.")).toBeTruthy();
    expect(screen.getByText(/The old copy is kept until/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove the old copy now" }));
    const dialog = await screen.findByRole("dialog");
    expect(purge).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove the old copy now" }));
    await waitFor(() => expect(purge).toHaveBeenCalledWith("m1"));
    await screen.findByText("Removed 1, kept 0");
  });

  it("a failed move says why, in words, and a failed check is flagged", async () => {
    vi.spyOn(api, "projectMoveList").mockResolvedValue([move({ phase: "FAILED", failureCode: "verify_failed", report: { checks: [{ code: "app_running", itemRef: "a1", name: "web", ok: false }], dns: [], warnings: [] } })]);
    show();
    expect((await screen.findByRole("alert")).textContent).toBe("The move finished but the check found a problem. See the report.");
    expect(screen.getByText("!")).toBeTruthy();
    // a finished move can be followed by a new one
    expect(screen.getByRole("button", { name: "Move to another server" })).toBeTruthy();
  });

  it("a failed move that changed something offers to undo it; the project's name is typed first; the call carries it", async () => {
    vi.spyOn(api, "projectMoveList").mockResolvedValue([move({ phase: "FAILED", failureCode: "partial_move", rollbackAvailable: true })]);
    const rollback = vi.spyOn(api, "projectMoveRollback").mockResolvedValue({ moveId: "m1", phase: "ROLLING_BACK" });
    show();
    expect((await screen.findByRole("alert")).textContent).toBe("Some items moved and some did not. Nothing was undone for you.");
    fireEvent.click(screen.getByRole("button", { name: "Undo this move" }));
    const dialog = await screen.findByRole("dialog");
    expect(rollback).not.toHaveBeenCalled();
    const go = within(dialog).getByRole("button", { name: "Undo this move" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Acme/), { target: { value: "Acme" } });
    fireEvent.click(go);
    await waitFor(() => expect(rollback).toHaveBeenCalledWith("m1", "Acme"));
  });

  it("no undo for a failed move that changed nothing, for a running or finished move, or while it is already rolling back", async () => {
    for (const m of [move({ phase: "FAILED", failureCode: "agent_offline", rollbackAvailable: false }), move({ phase: "MOVING", rollbackAvailable: true }), move({ phase: "COMPLETED", archiveUntil: null, rollbackAvailable: true }), move({ phase: "ROLLING_BACK" })]) {
      vi.spyOn(api, "projectMoveList").mockResolvedValue([m]);
      show();
      await screen.findByTestId("project-move-progress");
      expect(screen.queryByRole("button", { name: "Undo this move" })).toBeNull();
      cleanup();
    }
  });

  it("a refused undo says why in words", async () => {
    vi.spyOn(api, "projectMoveList").mockResolvedValue([move({ phase: "FAILED", failureCode: "partial_move", rollbackAvailable: true })]);
    vi.spyOn(api, "projectMoveRollback").mockRejectedValue(new ApiError(409, "child_move_active", "child_move_active"));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Undo this move" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Acme/), { target: { value: "Acme" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo this move" }));
    expect(await screen.findByText("An app move of this project is still running. Wait for it to finish.")).toBeTruthy();
  });

  it("the undone move says so in words", async () => {
    vi.spyOn(api, "projectMoveList").mockResolvedValue([move({ phase: "ROLLED_BACK", failureCode: "rolled_back_by_owner" })]);
    show();
    expect((await screen.findByRole("alert")).textContent).toBe("You undid this move. The apps are back on the old server.");
  });
});

describe("ProjectMovePanel: entry point", () => {
  it("says there is no move yet in one line, and links to the Move off Coolify checklist", async () => {
    show();
    expect((await screen.findByTestId("project-move-none")).textContent).toBe("No move yet. Nothing changes until you start one.");
    expect(screen.getByRole("link", { name: "Part of Move off Coolify, step C" }).getAttribute("href")).toBe("/import/move-off-coolify");
  });

  it("does not say there is no move once one exists", async () => {
    vi.spyOn(api, "projectMoveList").mockResolvedValue([move({ phase: "COMPLETED", finishedAt: "2026-11-26T01:00:00Z" })]);
    show();
    await screen.findByTestId("project-move-progress");
    expect(screen.queryByTestId("project-move-none")).toBeNull();
  });
});
