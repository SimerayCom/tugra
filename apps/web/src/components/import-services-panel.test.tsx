import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { ImportWizard } from "./import-wizard";
import { ImportServicesPanel } from "./import-services-panel";
import { ImportChecklist } from "./import-checklist";
import { api } from "../lib/api";
import importMessages from "../i18n/locales/en/import.json";
import type { ImportPlan, ImportServiceChoice, ImportServicePreview, ImportChecklistItem } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const REF_OK = "service:srv:svc-ok";
const REF_PART = "service:srv:svc-part";
const REF_SKIP = "service:srv:svc-skip";
const item = (ref: string, name: string, verdict: string, risks: ImportPlan["items"][number]["risks"] = []): ImportPlan["items"][number] => ({ itemRef: ref, kind: "service", name, proposed: { verdict }, risks, dependsOn: [] });
const plan: ImportPlan = {
  sourceKind: "coolify",
  mode: "copy",
  planHash: "b".repeat(32),
  warnings: [],
  totals: { apps: 0, databases: 0, volumes: 0, blockers: 0, services: 3 },
  items: [
    item(REF_OK, "search", "importable", [{ level: "warn", code: "service.deploy.manual", message: "created stopped" }]),
    item(REF_PART, "observability", "partial"),
    item(REF_SKIP, "agent", "skipped", [{ level: "info", code: "service.type.unsupported", message: "not imported" }]),
  ],
  preflight: {
    databases: [],
    appsWithVolumeData: 0,
    services: [
      { name: "search", members: 1, note: "imported as a stopped compose app; volume data is copied separately and you deploy it yourself", verdict: "importable" },
      { name: "observability", members: 6, note: "imported without: agent; created as a stopped compose app", verdict: "partial" },
      { name: "agent", members: 1, note: "not imported: every member needs something Tugra never carries", verdict: "skipped" },
    ],
  },
};
const base = (over: Partial<ImportServicePreview>): ImportServicePreview => ({
  itemRef: REF_OK,
  name: "search",
  verdict: "importable",
  compat: "template",
  members: [{ name: "meilisearch", status: "kept" }],
  env: { resolved: ["SERVICE_PASSWORD_MEILISEARCH"], missing: [], secretsAvailable: true },
  domains: [],
  domainHints: [{ service: "meilisearch", port: 7700 }],
  volumes: [{ key: "meilisearch-data", origin: "named", policy: "copy", dataPlane: "hub-staged", mounts: [{ service: "meilisearch", path: "/meili_data" }] }],
  files: { needed: [], available: [] },
  notCarried: [],
  blockers: [],
  floating: ["meilisearch"],
  pinned: [],
  hold: false,
  ...over,
});
const previews: ImportServicePreview[] = [
  base({}),
  base({
    itemRef: REF_PART,
    name: "observability",
    sourceServer: "localhost",
    verdict: "partial",
    compat: "passthrough",
    members: [{ name: "signoz", status: "kept" }, { name: "otel-collector", status: "kept" }, { name: "agent", status: "dropped", reason: "needs the Docker socket (never carried)" }],
    domains: [{ service: "signoz", hostname: "signoz.example.test", port: 8080 }],
    volumes: [
      { key: "clickhouse", origin: "named", policy: "skip", dataPlane: "not-carried", mounts: [{ service: "clickhouse", path: "/var/lib/clickhouse" }] },
      { key: "minio-data", origin: "host-bind", policy: "copy", dataPlane: "manual-large", mounts: [{ service: "minio", path: "/data" }] },
    ],
    floating: [],
    notCarried: [{ field: "agent.ports", reason: "published ports are not carried; use service domains", level: "warn" }],
    files: { needed: ["clickhouse/config.xml"], available: ["signoz:/root/config/prometheus.yml"] },
    env: { resolved: ["A"], missing: ["SIGNOZ_EMAILING_SMTP_ADDRESS"], secretsAvailable: true },
  }),
  base({ itemRef: REF_SKIP, name: "agent", verdict: "skipped", compat: "blocked", members: [{ name: "beszel-agent", status: "dropped", reason: "needs the Docker socket (never carried)" }], volumes: [], floating: [], blockers: [] }),
];

function renderPanel(over: { choices?: Record<string, ImportServiceChoice>; onChoice?: ReturnType<typeof vi.fn>; onMissing?: ReturnType<typeof vi.fn> } = {}) {
  const onChoice = over.onChoice ?? vi.fn();
  const onMissing = over.onMissing ?? vi.fn();
  wrap(<ImportServicesPanel sessionId="s1" kind="coolify" plan={plan} servers={[{ id: "srv-a", name: "Server A" }, { id: "srv-b", name: "Server B" }]} choices={over.choices ?? {}} onChoice={onChoice as never} onMissingTargets={onMissing as never} />);
  return { onChoice, onMissing };
}

describe("ImportServicesPanel", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/"); // a previous apply mirrored its op into ?op=
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "previewImportServices").mockResolvedValue({ services: previews });
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows a card per service with its verdict, summary counts, members with reasons and the compat line", async () => {
    renderPanel();
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Partial")).toBeTruthy();
    expect(screen.getAllByText("Not imported").length).toBeGreaterThan(0);
    expect(screen.getByText("An app-store template exists; imported with its own compose")).toBeTruthy();
    expect(screen.getAllByText("needs the Docker socket (never carried)").length).toBe(2);
    // a skipped service explains itself with the translated plan risk, never a raw code or source text
    expect(screen.getByText("Not imported: every member needs something Tugra never carries.")).toBeTruthy();
  });

  it("a service with no domain says it stays private; a mapped domain row is editable", async () => {
    const { onChoice } = renderPanel();
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    expect(screen.getByText("No domain is mapped: the service stays private and joins a private network.")).toBeTruthy();
    const host = screen.getAllByLabelText("Hostname")[0] as HTMLInputElement;
    expect(host.value).toBe("signoz.example.test");
    fireEvent.change(host, { target: { value: "obs.example.test" } });
    expect(onChoice).toHaveBeenCalledWith(REF_PART, { serviceDomains: [{ service: "signoz", hostname: "obs.example.test", port: 8080 }] });
  });

  it("a service on the source's own host requires an explicit target; choosing one clears it", async () => {
    const { onMissing, onChoice } = renderPanel();
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    await waitFor(() => expect(onMissing).toHaveBeenLastCalledWith(1));
    expect(screen.getByRole("alert").textContent).toContain("choose its target server");
    const selects = screen.getAllByLabelText("Target server") as HTMLSelectElement[];
    fireEvent.change(selects[1], { target: { value: "srv-b" } });
    expect(onChoice).toHaveBeenCalledWith(REF_PART, { targetServerId: "srv-b" });
  });

  it("no missing target once the choice has one, or the service is skipped by the operator", async () => {
    const { onMissing } = renderPanel({ choices: { [REF_PART]: { targetServerId: "srv-b" } } });
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    await waitFor(() => expect(onMissing).toHaveBeenLastCalledWith(0));
  });

  it("volume policy and owner overrides are sent as choices; host bind and manual-large are flagged", async () => {
    const { onChoice } = renderPanel();
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    expect(screen.getByText("Host folder, carried as a named volume")).toBeTruthy();
    expect(screen.getByText("copy by hand")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("meilisearch-data Data"), { target: { value: "empty" } });
    expect(onChoice).toHaveBeenCalledWith(REF_OK, { volumes: { "meilisearch-data": { policy: "empty", owner: undefined } } });
    fireEvent.change(screen.getByLabelText("meilisearch-data uid"), { target: { value: "1000" } });
    expect(onChoice).toHaveBeenLastCalledWith(REF_OK, { volumes: { "meilisearch-data": { policy: "copy", owner: { uid: 1000, gid: 1000 } } } });
  });

  it("rename, skip, leave a member out and pin a floating image all go through onChoice", async () => {
    const { onChoice } = renderPanel();
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    fireEvent.change(screen.getAllByLabelText("App name")[0], { target: { value: "My search" } });
    expect(onChoice).toHaveBeenLastCalledWith(REF_OK, { name: "My search" });
    fireEvent.click(screen.getAllByLabelText("Import this service")[0]);
    expect(onChoice).toHaveBeenLastCalledWith(REF_OK, { skip: true });
    fireEvent.click(screen.getByLabelText("Do not import otel-collector"));
    expect(onChoice).toHaveBeenLastCalledWith(REF_PART, { dropMembers: ["otel-collector"] });
    fireEvent.change(screen.getByPlaceholderText("repository:version"), { target: { value: "getmeili/meilisearch:v1.12.3" } });
    expect(onChoice).toHaveBeenLastCalledWith(REF_OK, { pins: { meilisearch: "getmeili/meilisearch:v1.12.3" } });
  });

  it("shows variable NAMES only (carried / missing), needed config files and the not-carried list", async () => {
    renderPanel();
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    expect(screen.getByText(/1 variables carried · 1 missing: SIGNOZ_EMAILING_SMTP_ADDRESS/)).toBeTruthy();
    expect(screen.getByText("Config files needed: clickhouse/config.xml")).toBeTruthy();
    expect(screen.getByText("Not carried (1)")).toBeTruthy();
  });

  it("when the token cannot read the variables the card says so", async () => {
    vi.spyOn(api, "previewImportServices").mockResolvedValue({ services: [base({ env: { resolved: [], missing: ["SERVICE_PASSWORD_MEILISEARCH"], secretsAvailable: false } })] });
    renderPanel();
    await screen.findByText(/needs read:sensitive/);
  });

  it("the layout is mobile-first: card controls sit in an auto-fit grid and rows wrap", async () => {
    const { container } = render(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <ImportServicesPanel sessionId="s1" kind="coolify" plan={plan} servers={[]} choices={{}} onChoice={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    expect(container.innerHTML).toMatch(/repeat\(auto-fit, minmax\(220px, 1fr\)\)/);
    expect(container.innerHTML).toMatch(/flex-wrap: wrap/);
  });

  it("a plan without services renders nothing and never calls the preview endpoint", async () => {
    const spy = vi.spyOn(api, "previewImportServices");
    const { container } = render(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <ImportServicesPanel sessionId="s1" kind="coolify" plan={{ ...plan, items: [] }} servers={[]} choices={{}} onChoice={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(container.innerHTML).toBe("");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("ImportWizard — services", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/"); // a previous apply mirrored its op into ?op=
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team One" }] as never);
    vi.spyOn(api, "listServers").mockResolvedValue([{ id: "srv1", name: "Server A", teamId: "t1", status: "ONLINE", clusterId: null, tags: [] }] as never);
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    vi.spyOn(api, "getMigrateCommand").mockResolvedValue({ opId: "op1", active: false, expiresAt: null, commandTemplate: "x" });
  });
  afterEach(() => vi.restoreAllMocks());

  async function toPlan() {
    wrap(<ImportWizard />);
    await screen.findByRole("option", { name: "Team One" });
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("Import preview");
  }

  it("the preflight lists imported and not-imported service stacks separately; the apply waits for the explicit target", async () => {
    vi.spyOn(api, "previewImportServices").mockResolvedValue({ services: previews });
    await toPlan();
    expect(screen.getByText("2 service stack(s) will be imported as stopped compose apps (nothing is deployed):")).toBeTruthy();
    expect(screen.getByText("1 service stack(s) are NOT imported:")).toBeTruthy();
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    const applyBtn = screen.getByRole("button", { name: "Import to Tugra" }) as HTMLButtonElement;
    await waitFor(() => expect(applyBtn.disabled).toBe(true)); // observability sits on the source's host: pick its target first
    fireEvent.change(screen.getAllByLabelText("Target server").filter((el) => el.tagName === "SELECT").at(-1)!, { target: { value: "srv1" } });
    await waitFor(() => expect(applyBtn.disabled).toBe(false));
  });

  it("apply sends serviceChoices only for what the operator changed", async () => {
    vi.spyOn(api, "previewImportServices").mockResolvedValue({ services: previews });
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue({ id: "op1", sourceKind: "coolify", serverId: "srv1", planHash: "b".repeat(32), status: "RUNNING", cancelRequested: false, createdAt: "2026-10-18T00:00:00.000Z", totals: { total: 0, done: 0, failed: 0, skipped: 0, running: 0, pending: 0, cancelled: 0, rolledBack: 0 }, tasks: [] } as never);
    await toPlan();
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    fireEvent.change(screen.getAllByLabelText("Target server").filter((el) => el.tagName === "SELECT").at(-1)!, { target: { value: "srv1" } });
    fireEvent.click(screen.getAllByLabelText("Import this service")[0]); // skip "search"
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await waitFor(() => expect(applySpy).toHaveBeenCalled());
    expect(applySpy.mock.calls[0][0]).toEqual({ sourceKind: "coolify", sessionId: "s1", targetServerId: "srv1", planHash: "b".repeat(32), serviceChoices: { [REF_OK]: { skip: true }, [REF_PART]: { targetServerId: "srv1" } } });
  });

  it("the timeline shows an applied service with its members, steps and the post-import checklist", async () => {
    vi.spyOn(api, "previewImportServices").mockResolvedValue({ services: previews });
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    const checklist: ImportChecklistItem[] = [
      { kind: "deploy-after-data", severity: "warn", params: { name: "search" } },
      { kind: "reach", severity: "info", params: { network: "svc-search", alias: "meilisearch" } },
    ];
    vi.spyOn(api, "getImportOperation").mockResolvedValue({
      id: "op1", sourceKind: "coolify", serverId: "srv1", planHash: "b".repeat(32), status: "SUCCEEDED", cancelRequested: false, createdAt: "2026-10-18T00:00:00.000Z",
      totals: { total: 1, done: 1, failed: 0, skipped: 0, running: 0, pending: 0, cancelled: 0, rolledBack: 0 },
      tasks: [{ itemRef: REF_OK, kind: "service", name: "search", status: "DONE", resourceType: "application", resourceId: "a1", message: null, startedAt: null, finishedAt: null, service: { members: ["meilisearch"], dropped: [], configMounts: 0, serviceDomains: { applied: 0, unmapped: [] }, privateNetwork: { network: "svc-search", alias: "meilisearch" }, volumes: [], hold: false, checklist, steps: [{ name: "prepare", status: "DONE" }, { name: "create", status: "DONE" }, { name: "done", status: "DONE" }] } }],
    } as never);
    await toPlan();
    await screen.findByText("1 ready · 1 partial · 1 not imported");
    fireEvent.change(screen.getAllByLabelText("Target server").filter((el) => el.tagName === "SELECT").at(-1)!, { target: { value: "srv1" } });
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("Members: meilisearch");
    expect(screen.getByText("Private network svc-search as meilisearch")).toBeTruthy();
    expect(screen.getByText("Next steps for search")).toBeTruthy();
    expect(screen.getByText("Nothing was deployed. Copy the data first, then deploy search yourself.")).toBeTruthy();
    expect(screen.getByText("search is private. Join network svc-search and use the name meilisearch to reach it.")).toBeTruthy();
    expect(screen.getByText("Prepare")).toBeTruthy();
  });
});

describe("ImportChecklist", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/"); // a previous apply mirrored its op into ?op=
    qc = new QueryClient();
  });
  it("renders one translated sentence per kind, with copy buttons only where a value is pasted", () => {
    const items: ImportChecklistItem[] = [
      { kind: "data-step", severity: "warn", params: { volumes: ["a", "b"], manualLarge: [] } },
      { kind: "quiesce", severity: "info", params: { members: ["meilisearch"] } },
      { kind: "dns", severity: "warn", params: { hosts: ["x.example.test", "y.example.test"], targetIp: "203.0.113.9" } },
      { kind: "tunnel", severity: "warn", params: { name: "cf" } },
      { kind: "repoint-dependents", severity: "warn", params: { name: "cf" } },
      { kind: "unpinned-image", severity: "warn", params: { services: ["meilisearch"] } },
      { kind: "not-carried", severity: "warn", params: { members: ["agent"], volumes: ["clickhouse"] } },
      { kind: "reach", severity: "info", params: { manual: 1 } },
    ];
    wrap(<ImportChecklist name="cf" items={items} />);
    expect(screen.getByText("Copy the data of a, b into the new volume(s) before the first deploy.")).toBeTruthy();
    expect(screen.getByText("Point x.example.test, y.example.test at the target server (203.0.113.9).")).toBeTruthy();
    expect(screen.getByText(/Stop the source connector and repoint the Cloudflare public-hostname origins by hand/)).toBeTruthy();
    expect(screen.getByText("cf is private. No network was attached: add one in the app's network settings.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(1); // only the DNS rows are pasted
  });
  it("renders nothing for an empty checklist", () => {
    const { container } = render(<I18nProvider><ImportChecklist name="x" items={[]} /></I18nProvider>);
    expect(container.innerHTML).toBe("");
  });
});

describe("import services i18n", () => {
  const lookup = (k: string): unknown => k.split(".").slice(1).reduce<unknown>((n, p) => (n && typeof n === "object" ? (n as Record<string, unknown>)[p] : undefined), importMessages);
  const read = (f: string) => readFileSync(path.resolve(__dirname, f), "utf8");
  const SRC = ["import-services-panel.tsx", "import-checklist.tsx", "import-wizard.tsx"].map(read).join("\n");

  it("every literal import.* key used by the services UI resolves to a string", () => {
    const used = new Set<string>();
    for (const m of SRC.matchAll(/["'`](import\.[A-Za-z0-9_.-]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(60);
    expect([...used].filter((k) => typeof lookup(k) !== "string")).toEqual([]);
  });

  it("every key under import.services is used by the UI (no dead copy) and the old servicesNotImported key is gone", () => {
    const keys: string[] = [];
    const walk = (node: unknown, prefix: string) => {
      if (typeof node === "string") keys.push(prefix);
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, `${prefix}.${k}`);
    };
    walk((importMessages as { services: unknown }).services, "import.services");
    const dead = keys.filter((k) => !SRC.includes(`"${k}"`));
    expect(dead).toEqual([]);
    expect((importMessages as Record<string, unknown>).servicesNotImported).toBeUndefined();
    expect(SRC).not.toContain("servicesNotImported");
  });

  it("has a risk sentence for every service risk code the hub planner emits", () => {
    const planner = readFileSync(path.resolve(__dirname, "../../../hub-api/src/importer/import-planner.ts"), "utf8");
    const codes = new Set([...planner.matchAll(/code: "(service\.[a-z.-]+)"/g)].map((m) => m[1]));
    for (const c of ["service.compose.unparsed", "service.volume.name", "service.gate"]) codes.add(c);
    expect(codes.size).toBeGreaterThanOrEqual(16);
    const panel = read("import-services-panel.tsx");
    expect([...codes].filter((c) => !panel.includes(`"${c}"`))).toEqual([]);
  });
});
