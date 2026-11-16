import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import { GuidedRunLauncher } from "./guided-run-launcher";
import { mkRun } from "./test-fixtures";
import type { ImportPlan } from "../../lib/types";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(cleanup);
let qc: QueryClient;
const plan = { sourceKind: "coolify", mode: "copy", planHash: "a".repeat(32), warnings: [], totals: { apps: 1, databases: 0, volumes: 0, blockers: 0 }, items: [] } as ImportPlan;
const servers = [{ id: "srv1", name: "Server A", teamId: "t1" }, { id: "srv2", name: "Server B", teamId: "t1" }];
const extras = { acks: [{ code: "app.env.unresolved" as const, itemRef: "app:s:web" }] };
const mount = (over: Partial<React.ComponentProps<typeof GuidedRunLauncher>> = {}) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <GuidedRunLauncher plan={plan} kind="coolify" sessionId="s1" servers={servers} extras={extras} {...over} />
      </I18nProvider>
    </QueryClientProvider>,
  );
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  push.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("GuidedRunLauncher", () => {
  it("creates a DRY run by default from the reviewed plan, with its acks, and opens it", async () => {
    const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun({ id: "newrun" }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByRole("checkbox", { name: "Dry run first" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create dry run" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      sessionId: "s1", sourceKind: "coolify", targetServerId: "srv1", planHash: "a".repeat(32), dryRun: true, mode: "copy", topology: "two-box",
      acks: [{ code: "app.env.unresolved", itemRef: "app:s:web" }], inputs: { acmeEmail: "unknown", sourceController: "manual" },
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/import/runs/newrun"));
  });

  it("a real run needs the dry-run box cleared; takeover and swap-proxy are explained", async () => {
    const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun({ id: "real" }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Dry run first" }));
    fireEvent.change(within(dialog).getByLabelText("Mode"), { target: { value: "takeover" } });
    expect(within(dialog).getByText(/can be stopped \(never deleted\)/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Topology"), { target: { value: "swap-proxy" } });
    expect(within(dialog).getByText(/DNS is not touched/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("ACME certificate email"), { target: { value: "ops@example.org" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create run" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ dryRun: false, mode: "takeover", topology: "swap-proxy", inputs: { acmeEmail: "ops@example.org" } });
  });

  it("blocks an invalid email and an out-of-range observe window", async () => {
    const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun());
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Create dry run" }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText("ACME certificate email"), { target: { value: "nope" } });
    expect(submit.disabled).toBe(true);
    expect(within(dialog).getAllByRole("alert")[0].textContent).toContain("valid email");
    fireEvent.change(within(dialog).getByLabelText("ACME certificate email"), { target: { value: "" } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText("Observe window (minutes)"), { target: { value: "9999" } });
    expect(submit.disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("shows a localized error and stays open when the hub refuses", async () => {
    vi.spyOn(api, "createMigrationRun").mockRejectedValue(new Error("409 plan changed"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create dry run" }));
    await waitFor(() => expect(push).not.toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("is disabled while the plan is not ready, and cannot submit without a target server", async () => {
    mount({ disabled: true });
    expect((screen.getByRole("button", { name: "Run guided migration" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mount({ servers: [] });
    fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByRole("button", { name: "Create dry run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe("fleet options", () => {
    const fleetPlan = {
      ...plan,
      items: [
        { itemRef: "app:host-a:web", kind: "app", name: "web", proposed: {}, risks: [], dependsOn: [] },
        { itemRef: "database:host-b:db", kind: "database", name: "db", proposed: {}, risks: [], dependsOn: [] },
      ],
    } as unknown as ImportPlan;

    it("maps each source host to a Tugra server and sends it as the run's serverMap", async () => {
      const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun({ id: "multi" }));
      mount({ plan: fleetPlan });
      fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
      const dialog = await screen.findByRole("dialog");
      // off by default: no map is sent and no host row is shown
      expect(within(dialog).queryByLabelText("Tugra server for host-a")).toBeNull();
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "Place source hosts on different Tugra servers" }));
      fireEvent.change(within(dialog).getByLabelText("Tugra server for host-b"), { target: { value: "srv2" } });
      expect(within(dialog).getByText(/2 source hosts on 2 Tugra servers/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Create dry run" }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0][0]).toMatchObject({ targetServerId: "srv1", serverMap: { "host-a": "srv1", "host-b": "srv2" } });
    });

    it("a plain run sends no serverMap, and placement is hidden when there is only one server to choose", async () => {
      const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun());
      mount({ plan: fleetPlan });
      fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Create dry run" }));
      await waitFor(() => expect(create).toHaveBeenCalled());
      expect(create.mock.calls[0][0]).not.toHaveProperty("serverMap");
      cleanup();
      mount({ plan: fleetPlan, servers: [servers[0]] });
      fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByRole("checkbox", { name: "Place source hosts on different Tugra servers" })).toBeNull();
    });

    it("a host that sat on the old default follows a changed default target, one moved elsewhere stays", async () => {
      const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun());
      mount({ plan: fleetPlan, servers: [...servers, { id: "srv3", name: "Server C", teamId: "t1" }] });
      fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "Place source hosts on different Tugra servers" }));
      fireEvent.change(within(dialog).getByLabelText("Tugra server for host-b"), { target: { value: "srv2" } });
      fireEvent.change(within(dialog).getByLabelText("Target server"), { target: { value: "srv3" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create dry run" }));
      await waitFor(() => expect(create).toHaveBeenCalled());
      expect(create.mock.calls[0][0]).toMatchObject({ targetServerId: "srv3", serverMap: { "host-a": "srv3", "host-b": "srv2" } });
    });

    it("offers only servers of the target's team for placement", async () => {
      mount({ plan: fleetPlan, servers: [...servers, { id: "srv9", name: "Other team", teamId: "t9" }] });
      fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "Place source hosts on different Tugra servers" }));
      const options = within(within(dialog).getByLabelText("Tugra server for host-a")).getAllByRole("option").map((o) => o.textContent);
      expect(options).toEqual(expect.arrayContaining(["Server A", "Server B"]));
      expect(options).not.toContain("Other team");
    });

    it("sends the host-loop runner, build options and policy answers, and blocks an unsafe key directory", async () => {
      const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun());
      mount({ plan: fleetPlan });
      fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText("Who runs the migrator on the source hosts"), { target: { value: "coolify-host-loop" } });
      const submit = within(dialog).getByRole("button", { name: "Create dry run" }) as HTMLButtonElement;
      fireEvent.change(within(dialog).getByLabelText("SSH key directory on the Coolify host"), { target: { value: "/data/../etc" } });
      expect(submit.disabled).toBe(true);
      fireEvent.change(within(dialog).getByLabelText("SSH key directory on the Coolify host"), { target: { value: "/data/coolify/ssh/keys" } });
      fireEvent.change(within(dialog).getByLabelText("Hosts at a time"), { target: { value: "3" } });
      fireEvent.change(within(dialog).getByLabelText("When apps are built and started"), { target: { value: "earlyBuild" } });
      fireEvent.change(within(dialog).getByLabelText("Databases too large for a dump artifact"), { target: { value: "stream-logical" } });
      fireEvent.change(within(dialog).getByLabelText("Hosts that use the source's object storage"), { target: { value: "mirror" } });
      fireEvent.change(within(dialog).getByLabelText("Campaign"), { target: { value: "wave-1" } });
      expect(submit.disabled).toBe(false);
      fireEvent.click(submit);
      await waitFor(() => expect(create).toHaveBeenCalled());
      const body = create.mock.calls[0][0];
      expect(body.options).toMatchObject({ sourceRunner: "coolify-host-loop", hostLoop: { keyDir: "/data/coolify/ssh/keys", parallel: 3, connectTimeoutSec: 15, retries: 1 }, deployWaves: "earlyBuild", largeDbMode: "stream-logical" });
      expect(body.inputs).toMatchObject({ minioPolicy: "mirror" });
      expect(body.inputs).not.toHaveProperty("workerPolicy"); // unanswered: the hub's safe default applies
      expect(body.campaign).toBe("wave-1");
    });
  });
});
