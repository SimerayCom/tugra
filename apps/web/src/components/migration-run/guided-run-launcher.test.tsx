import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import { GuidedRunLauncher } from "./guided-run-launcher";
import { mkRun } from "./test-fixtures";
import type { ImportPlan } from "../../lib/types";
import type { ImportScope } from "../../lib/import-scope";

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

  it("the '?' points at the Move from Coolify guide, and at the same-server guide once swap-proxy is chosen", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Guide: Move from Coolify" }).getAttribute("href")).toBe("https://tugra.io/docs/move-from-coolify");
    fireEvent.change(within(dialog).getByLabelText("Topology"), { target: { value: "swap-proxy" } });
    expect(within(dialog).getByRole("link", { name: "Guide: Move from Coolify on the same server" }).getAttribute("href")).toBe("https://tugra.io/docs/move-from-coolify-same-server");
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

    it("lists each source host by the name the plan gives it, and still maps it by its uuid", async () => {
      const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun());
      const named = { ...fleetPlan, preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts: [{ ref: "host-a", name: "Alpha box" }, { ref: "host-b", name: "Beta box" }] } } as unknown as ImportPlan;
      mount({ plan: named });
      fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "Place source hosts on different Tugra servers" }));
      expect(within(dialog).getByText("Source host Alpha box")).toBeTruthy();
      expect(within(dialog).queryByText("Source host host-a")).toBeNull();
      fireEvent.change(within(dialog).getByLabelText("Tugra server for Beta box"), { target: { value: "srv2" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create dry run" }));
      await waitFor(() => expect(create).toHaveBeenCalled());
      expect(create.mock.calls[0][0]).toMatchObject({ serverMap: { "host-a": "srv1", "host-b": "srv2" } });
    });

    it("explains what each large-database choice does, and the text follows the choice", async () => {
      mount({ plan: fleetPlan });
      fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/counts as downtime/)).toBeTruthy();
      expect(within(dialog).queryByText(/pauses the run/)).toBeNull();
      fireEvent.change(within(dialog).getByLabelText("Very large databases"), { target: { value: "refuse" } });
      expect(within(dialog).getByText(/pauses the run/)).toBeTruthy();
      expect(within(dialog).queryByText(/counts as downtime/)).toBeNull();
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
      fireEvent.change(within(dialog).getByLabelText("Very large databases"), { target: { value: "refuse" } });
      fireEvent.change(within(dialog).getByLabelText("Which services are started before the apps"), { target: { value: "all" } });
      fireEvent.change(within(dialog).getByLabelText("Hosts that use the source's object storage"), { target: { value: "mirror" } });
      fireEvent.change(within(dialog).getByLabelText("Campaign"), { target: { value: "wave-1" } });
      expect(submit.disabled).toBe(false);
      fireEvent.click(submit);
      await waitFor(() => expect(create).toHaveBeenCalled());
      const body = create.mock.calls[0][0];
      expect(body.options).toMatchObject({ sourceRunner: "coolify-host-loop", hostLoop: { keyDir: "/data/coolify/ssh/keys", parallel: 3, connectTimeoutSec: 15, retries: 1 }, deployWaves: "earlyBuild", largeDbMode: "refuse", serviceStart: "all" });
      expect(body.inputs).toMatchObject({ minioPolicy: "mirror" });
      expect(body.inputs).not.toHaveProperty("workerPolicy"); // unanswered: the hub's safe default applies
      expect(body.campaign).toBe("wave-1");
    });
  });

  it("a narrowed move carries its scope and placement, starts from the first step's target, and sends no mapping", async () => {
    const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun({ id: "scoped1" }));
    const scope: ImportScope = {
      selection: { mode: "servers", hosts: new Set(["s2", "s1"]), projects: new Set(), extra: new Set(["database:s3:db"]), placement: { s1: "srv1", s2: "srv2" } },
      inScope: new Set(["app:s1:web", "app:s2:api", "database:s3:db"]),
      narrowed: true,
      defaultServerId: "srv2",
      serverMap: { s1: "srv1", s2: "srv2" },
      placed: { s1: "srv1", s2: "srv2" },
      placementKind: { s1: "other-server", s2: "other-server" },
    };
    const item = (itemRef: string, kind: "app" | "database") => ({ itemRef, kind, name: itemRef, proposed: {}, risks: [], dependsOn: [] });
    const scoped = { ...plan, items: [item("app:s1:web", "app"), item("app:s2:api", "app"), item("database:s3:db", "database")] } as ImportPlan;
    mount({ plan: scoped, scope });
    fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Moves only the 3 items you chose.")).toBeTruthy();
    expect((within(dialog).getByLabelText("Target server") as HTMLSelectElement).value).toBe("srv2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create dry run" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const body = create.mock.calls[0][0];
    expect(body).toMatchObject({ targetServerId: "srv2", serverMap: { s1: "srv1", s2: "srv2" }, scope: { sourceServers: ["s1", "s2"], include: ["database:s3:db"] } });
    expect(body).not.toHaveProperty("mapping");
  });

  it("a move of the whole source sends no scope and says nothing about one", async () => {
    const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun({ id: "whole1" }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/Moves only/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create dry run" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).not.toHaveProperty("scope");
  });

  describe("the first step's choice", () => {
    const item = (itemRef: string, kind: "app" | "database") => ({ itemRef, kind, name: itemRef, proposed: {}, risks: [], dependsOn: [] });
    const whole = { ...plan, items: [item("app:s1:web", "app"), item("app:s2:api", "app"), item("database:s2:db", "database")] } as ImportPlan;
    const everything = (over: Partial<ImportScope> = {}): ImportScope => ({
      selection: { mode: "everything", hosts: new Set(), projects: new Set(), extra: new Set(), placement: { s1: "srv2", s2: "srv2" } },
      inScope: new Set(["app:s1:web", "app:s2:api", "database:s2:db"]),
      narrowed: false,
      defaultServerId: "srv2",
      serverMap: undefined,
      placed: { s1: "srv2", s2: "srv2" },
      placementKind: { s1: "other-server", s2: "other-server" },
      ...over,
    });
    const open = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
      return screen.findByRole("dialog");
    };

    it("moving everything still starts from the target the first step picked, not the first server", async () => {
      const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun({ id: "all1" }));
      mount({ plan: whole, scope: everything() });
      const dialog = await open();
      expect((within(dialog).getByLabelText("Target server") as HTMLSelectElement).value).toBe("srv2");
      expect(within(dialog).getByTestId("launch-summary").textContent).toContain("2 apps, 1 databases and 0 services, moving to Server B.");
      expect(within(dialog).getByTestId("launch-summary").textContent).toContain("Another server");
      fireEvent.click(within(dialog).getByRole("button", { name: "Create dry run" }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0][0]).toMatchObject({ targetServerId: "srv2", dryRun: true, topology: "two-box" });
    });

    it("carries the several-server placement of a whole move", async () => {
      const create = vi.spyOn(api, "createMigrationRun").mockResolvedValue(mkRun({ id: "all2" }));
      mount({ plan: whole, scope: everything({ serverMap: { s1: "srv1", s2: "srv2" } }) });
      const dialog = await open();
      fireEvent.click(within(dialog).getByRole("button", { name: "Create dry run" }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0][0]).toMatchObject({ targetServerId: "srv2", serverMap: { s1: "srv1", s2: "srv2" } });
    });

    it("the Target select stays in the first step's team", async () => {
      mount({ plan: whole, scope: everything(), servers: [...servers, { id: "srv9", name: "Other team box", teamId: "t2" }] });
      const dialog = await open();
      const options = [...(within(dialog).getByLabelText("Target server") as HTMLSelectElement).options].map((o) => o.textContent);
      expect(options).not.toContain("Other team box");
    });

    it("an in-place choice starts on the proxy swap for Coolify, never for Dokploy", async () => {
      mount({ plan: whole, scope: everything({ placed: { s1: "srv2" }, placementKind: { s1: "in-place" } }) });
      let dialog = await open();
      expect((within(dialog).getByLabelText("Topology") as HTMLSelectElement).value).toBe("swap-proxy");
      expect(within(dialog).getByTestId("launch-summary").textContent).toContain("Same machine");
      cleanup();
      mount({ plan: whole, scope: everything({ placed: { s1: "srv2" }, placementKind: { s1: "in-place" } }), kind: "dokploy" });
      dialog = await open();
      expect((within(dialog).getByLabelText("Topology") as HTMLSelectElement).value).toBe("two-box");
      expect([...(within(dialog).getByLabelText("Topology") as HTMLSelectElement).options].map((o) => o.value).filter(Boolean)).toEqual(["two-box"]);
    });

    it("the summary's Change goes back to the first step", async () => {
      const onChangeScope = vi.fn();
      mount({ plan: whole, scope: everything(), onChangeScope });
      const dialog = await open();
      fireEvent.click(within(dialog).getByRole("button", { name: "Change" }));
      expect(onChangeScope).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("blocks Create and says why when a server the run uses is offline or lacks deploy and database", async () => {
      const facts = [
        { id: "srv1", name: "Server A", teamId: "t1", status: "ONLINE" as const, capabilities: ["deploy", "database"] },
        { id: "srv2", name: "Server B", teamId: "t1", status: "ONLINE" as const, capabilities: ["deploy"] },
        { id: "srv3", name: "Server C", teamId: "t1", status: "OFFLINE" as const, capabilities: ["deploy", "database"] },
      ];
      mount({ plan: whole, scope: everything(), servers: facts });
      let dialog = await open();
      expect(within(dialog).getByText(/Needs the Databases capability on this server\./)).toBeTruthy();
      expect((within(dialog).getByRole("button", { name: "Create dry run" }) as HTMLButtonElement).disabled).toBe(true);
      const sel = within(dialog).getByLabelText("Target server") as HTMLSelectElement;
      expect([...sel.options].find((o) => o.textContent?.startsWith("Server C"))?.textContent).toBe("Server C (offline)");
      cleanup();
      // with no first-step choice the default is the first server that can take the run
      mount({ servers: facts });
      dialog = await open();
      expect((within(dialog).getByLabelText("Target server") as HTMLSelectElement).value).toBe("srv1");
    });
  });
});

describe("GuidedRunLauncher: a move needs an agent on every source server", () => {
  const item = (ref: string, kind: "app" | "database" = "app") => ({ itemRef: `${kind}:${ref}:1`, kind, name: ref, proposed: {}, risks: [], dependsOn: [] });
  const gapPlan = {
    ...plan,
    items: [item("srv-a"), item("srv-b", "database")],
    preflight: {
      hosts: [
        { ref: "srv-a", name: "Edge A", tugra: { serverId: "t1", name: "edge-a", teamId: "t1", via: "public-ip", confidence: "certain" }, agentOnline: true },
        { ref: "srv-b", name: "Edge B", agentOnline: false },
      ],
    },
  } as unknown as ImportPlan;
  const open = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
    return await screen.findByRole("dialog");
  };

  it("names the source servers that have no agent and how to add one, but still allows a dry run", async () => {
    mount({ plan: gapPlan });
    const dialog = await open();
    const note = within(dialog).getByTestId("agent-gap");
    expect(note.textContent).toContain("Edge B");
    expect(note.textContent).toContain("No agent");
    expect(note.textContent).not.toContain("Edge A");
    expect(within(note).getByRole("link", { name: "Open the Coolify page" }).getAttribute("href")).toBe("/import/coolify-host");
    expect((within(dialog).getByRole("button", { name: "Create dry run" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses a real run until every source server has an agent", async () => {
    mount({ plan: gapPlan });
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Dry run first" }));
    expect((within(dialog).getByRole("button", { name: "Create run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says nothing when every source server has an agent, and for a source other than Coolify", async () => {
    const covered = { ...gapPlan, preflight: { hosts: gapPlan.preflight!.hosts!.map((h) => ({ ...h, agentOnline: true })) } } as unknown as ImportPlan;
    mount({ plan: covered });
    const dialog = await open();
    expect(within(dialog).queryByTestId("agent-gap")).toBeNull();
    cleanup();
    mount({ plan: gapPlan, kind: "dokploy" });
    const d2 = await open();
    expect(within(d2).queryByTestId("agent-gap")).toBeNull();
  });
});

describe("a mixed placement is a campaign", () => {
  const item = (itemRef: string, kind: "app" | "database") => ({ itemRef, kind, name: itemRef, proposed: {}, risks: [], dependsOn: [] });
  const whole = { ...plan, items: [item("app:s1:web", "app"), item("app:s2:api", "app")], preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts: [{ ref: "s1", name: "Alpha" }, { ref: "s2", name: "Beta" }] } } as unknown as ImportPlan;
  const mixed: ImportScope = {
    selection: { mode: "everything", hosts: new Set(), projects: new Set(), extra: new Set(), placement: { s1: "srv1", s2: "srv2" } },
    inScope: new Set(["app:s1:web", "app:s2:api"]),
    narrowed: false,
    defaultServerId: "srv1",
    serverMap: undefined,
    placed: { s1: "srv1", s2: "srv2" },
    placementKind: { s1: "in-place", s2: "other-server" },
  };
  const runs = [
    { sourceServerRef: "s2", kind: "other-server" as const, targetServerId: "srv2", topology: "two-box" as const, wave: 0 },
    { sourceServerRef: "s1", kind: "in-place" as const, targetServerId: "srv1", topology: "swap-proxy" as const, wave: 1 },
  ];
  const open = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Run guided migration" }));
    return screen.findByRole("dialog");
  };

  it("shows the runs the hub would create, asks for no topology and creates the campaign, then opens its report", async () => {
    const planCampaign = vi.spyOn(api, "planCampaign").mockResolvedValue({ planHash: "a".repeat(32), views: [], runs, failure: null });
    const createCampaign = vi.spyOn(api, "createCampaign").mockResolvedValue({ id: "c1", label: "campaign-x", sessionId: "s1", status: "draft", plan: runs, runIds: ["r1", "r2"], createdAt: "2026-11-26T10:00:00Z" });
    const createRun = vi.spyOn(api, "createMigrationRun");
    mount({ plan: whole, scope: mixed });
    const dialog = await open();
    expect(within(dialog).queryByLabelText("Topology")).toBeNull();
    const card = await within(dialog).findByTestId("campaign-preview");
    await waitFor(() => expect(card.textContent).toContain("Wave 2"));
    expect(card.textContent).toContain("Beta moves to Server B");
    expect(card.textContent).toContain("Alpha stays on its own machine");
    expect(planCampaign.mock.calls[0][0]).toEqual({
      sessionId: "s1",
      planHash: "a".repeat(32),
      placements: [{ sourceServerRef: "s1", kind: "in-place", targetServerId: "srv1" }, { sourceServerRef: "s2", kind: "other-server", targetServerId: "srv2" }],
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create campaign (2 runs)" }));
    await waitFor(() => expect(createCampaign).toHaveBeenCalledTimes(1));
    expect(createCampaign.mock.calls[0][0]).toMatchObject({ sessionId: "s1", planHash: "a".repeat(32), confirm: 2, dryRun: true });
    expect(createCampaign.mock.calls[0][0]).not.toHaveProperty("targetServerId");
    expect(createCampaign.mock.calls[0][0]).not.toHaveProperty("topology");
    expect(createRun).not.toHaveBeenCalled();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/import/runs/campaign?c=campaign-x"));
  });

  it("a refused placement says why and keeps the create button off", async () => {
    vi.spyOn(api, "planCampaign").mockResolvedValue({ planHash: "a".repeat(32), views: [], runs: null, failure: { code: "placement_in_place_locked", ref: "s1", reason: "agent_offline" } });
    const createCampaign = vi.spyOn(api, "createCampaign");
    mount({ plan: whole, scope: mixed });
    const dialog = await open();
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Staying on the same machine is not possible for this server.");
    expect(alert.textContent).toContain("Alpha");
    expect(alert.textContent).toContain("The agent on this server is offline.");
    const submit = within(dialog).getByRole("button", { name: /Create campaign/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.submit(submit.closest("form")!);
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it("an unreadable check keeps the button off too", async () => {
    vi.spyOn(api, "planCampaign").mockRejectedValue(new Error("down"));
    mount({ plan: whole, scope: mixed });
    const dialog = await open();
    await within(dialog).findByText("The placement could not be checked. Try again.");
    expect((within(dialog).getByRole("button", { name: /Create campaign/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("several same-machine servers are a campaign too; one is a plain run", async () => {
    const planCampaign = vi.spyOn(api, "planCampaign").mockResolvedValue({ planHash: "a".repeat(32), views: [], runs, failure: null });
    mount({ plan: whole, scope: { ...mixed, placementKind: { s1: "in-place", s2: "in-place" } } });
    await open();
    await waitFor(() => expect(planCampaign).toHaveBeenCalled());
    cleanup();
    planCampaign.mockClear();
    mount({ plan: whole, scope: { ...mixed, placed: { s1: "srv1" }, placementKind: { s1: "in-place" } } });
    const dialog = await open();
    expect(within(dialog).getByLabelText("Topology")).toBeTruthy();
    expect(planCampaign).not.toHaveBeenCalled();
  });

  it("a Dokploy source never makes a campaign", async () => {
    const planCampaign = vi.spyOn(api, "planCampaign");
    mount({ plan: whole, scope: mixed, kind: "dokploy" });
    const dialog = await open();
    expect(within(dialog).queryByTestId("campaign-preview")).toBeNull();
    expect(planCampaign).not.toHaveBeenCalled();
  });
});
