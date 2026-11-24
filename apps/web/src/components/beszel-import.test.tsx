import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { I18nProvider } from "../i18n/provider";
import { BeszelImport } from "./beszel-import";
import { api, ApiError } from "../lib/api";
import messages from "../i18n/locales/en/beszelImport.json";
import type { BeszelApplyResult, BeszelPreview } from "../lib/beszel-import";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

const preview = (over: Partial<BeszelPreview> = {}): BeszelPreview => ({
  sessionId: "s1",
  host: "beszel.example.com",
  hash: "a".repeat(32),
  emails: 2,
  servers: [{ id: "srv1", name: "app-1" }, { id: "srv2", name: "db" }],
  systems: [
    { id: "sysA", name: "app-1", host: "203.0.113.5", status: "up", match: { serverId: "srv1", serverName: "app-1", by: "ip" } },
    { id: "sysB", name: "db-1", host: "198.51.100.9", status: "up", match: null, unmatchedReason: "none" },
  ],
  alerts: [
    { id: "a1", systemId: "sysA", systemName: "app-1", serverId: "srv1", name: "CPU", outcome: "create", metric: "CPU", limit: 80, unit: "%", minutes: 5 },
    { id: "a2", systemId: "sysA", systemName: "app-1", serverId: "srv1", name: "Status", outcome: "covered", minutes: 1 },
    { id: "a3", systemId: "sysA", systemName: "app-1", serverId: "srv1", name: "GPU", outcome: "skip", reason: "gpu", minutes: 1 },
  ],
  channels: [
    { index: 0, service: "telegram", label: "chat @ops", type: "telegram", outcome: "create", notes: [] },
    { index: 1, service: "zulip", label: "z.example.com", type: null, outcome: "skip", reason: "unsupportedService", notes: [] },
  ],
  history: { windowDays: 30, totalPoints: 120, systems: [{ systemId: "sysA", serverId: "srv1", points: 120, from: null, to: null }] },
  ...over,
});
const applied: BeszelApplyResult = {
  channels: { created: 1, existing: 0, failed: 0, skipped: 1 },
  monitors: { created: 1, existing: 0, failed: 0, skipped: 1, covered: 1 },
  history: { systems: 1, points: 120 },
  failures: [],
  credentialsDropped: true,
};

async function connect() {
  fireEvent.change(screen.getByLabelText(messages.connect.url), { target: { value: "https://beszel.example.com" } });
  fireEvent.change(screen.getByLabelText(messages.connect.identity), { target: { value: "me@example.com" } });
  fireEvent.change(screen.getByLabelText(messages.connect.password), { target: { value: "s3cret" } });
  fireEvent.click(screen.getByRole("button", { name: messages.connect.submit }));
}

describe("BeszelImport", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team" }] as never);
    vi.spyOn(api, "listServers").mockResolvedValue([{ id: "srv1", name: "app-1", teamId: "t1", canWrite: true }] as never);
    vi.spyOn(api, "beszelSessions").mockResolvedValue([]);
    vi.spyOn(api, "beszelConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "", host: "beszel.example.com", credentialsKept: false });
    vi.spyOn(api, "beszelPreview").mockResolvedValue(preview());
  });
  afterEach(() => vi.restoreAllMocks());

  it("connects with the typed credentials for the writable team, then shows the review", async () => {
    wrap(<BeszelImport />);
    await waitFor(() => expect(screen.getByLabelText(messages.connect.url)).toBeTruthy());
    await connect();
    await screen.findByText(messages.review.title);
    expect(api.beszelConnect).toHaveBeenCalledWith({ teamId: "t1", baseUrl: "https://beszel.example.com", identity: "me@example.com", password: "s3cret", keepCredentials: false });
    expect(api.beszelPreview).toHaveBeenCalledWith({ sessionId: "s1" });
    expect(screen.getByText("1 servers matched")).toBeTruthy();
    expect(screen.getByText("1 alerts")).toBeTruthy();
    expect(screen.getByText("120 history points")).toBeTruthy();
  });

  it("says why a login failed, in words, without the password", async () => {
    vi.spyOn(api, "beszelConnect").mockRejectedValue(new ApiError(400, "x", "badCredentials"));
    wrap(<BeszelImport />);
    await waitFor(() => expect(screen.getByLabelText(messages.connect.url)).toBeTruthy());
    await connect();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(messages.err.badCredentials);
    expect(alert.textContent).not.toContain("s3cret");
    expect(api.beszelPreview).not.toHaveBeenCalled();
  });

  it("lists an unmatched system with a picker, and re-previews with the manual match", async () => {
    wrap(<BeszelImport />);
    await waitFor(() => expect(screen.getByLabelText(messages.connect.url)).toBeTruthy());
    await connect();
    await screen.findByText(messages.review.title);
    expect(screen.getByText(messages.systems.unmatched.none)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Tugra server for db-1"), { target: { value: "srv2" } });
    await waitFor(() => expect(api.beszelPreview).toHaveBeenLastCalledWith({ sessionId: "s1", serverOverrides: { sysB: "srv2" } }));
  });

  it("keeps the details behind More and explains what is covered or not carried", async () => {
    wrap(<BeszelImport />);
    await waitFor(() => expect(screen.getByLabelText(messages.connect.url)).toBeTruthy());
    await connect();
    await screen.findByText(messages.review.title);
    expect(document.body.textContent).toContain("app-1 · CPU at 80% for 5 min");
    expect(screen.getByText(messages.alerts.coveredHelp)).toBeTruthy();
    expect(screen.getByText(messages.alerts.skip.gpu)).toBeTruthy();
    expect(screen.getByText(messages.channels.skip.unsupportedService)).toBeTruthy();
    expect(screen.getByText("2 email addresses in Beszel are not imported. Add an email channel in Tugra and attach it to the monitors.")).toBeTruthy();
    expect(document.querySelectorAll("details").length).toBeGreaterThanOrEqual(3);
  });

  it("applies the reviewed preview and shows the outcome; unticking a part leaves it out", async () => {
    const apply = vi.spyOn(api, "beszelApply").mockResolvedValue(applied);
    wrap(<BeszelImport />);
    await waitFor(() => expect(screen.getByLabelText(messages.connect.url)).toBeTruthy());
    await connect();
    await screen.findByText(messages.review.title);
    fireEvent.click(screen.getByLabelText(messages.parts.history));
    fireEvent.click(screen.getByRole("button", { name: messages.apply.button }));
    await screen.findByText(messages.result.title);
    expect(apply).toHaveBeenCalledWith({ sessionId: "s1", previewHash: "a".repeat(32), parts: { alerts: true, channels: true, history: false }, systemIds: ["sysA"] });
    expect(screen.getByText("1 monitors created, 0 already existed, 1 covered by the built-in offline alert.")).toBeTruthy();
    expect(screen.getByText(messages.result.dropped)).toBeTruthy();
  });

  it("will not apply with every part unticked", async () => {
    wrap(<BeszelImport />);
    await waitFor(() => expect(screen.getByLabelText(messages.connect.url)).toBeTruthy());
    await connect();
    await screen.findByText(messages.review.title);
    for (const k of ["alerts", "channels", "history"] as const) fireEvent.click(screen.getByLabelText(messages.parts[k]));
    expect((screen.getByRole("button", { name: messages.apply.button }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for a new preview when the hub says it moved (409)", async () => {
    vi.spyOn(api, "beszelApply").mockRejectedValue(new ApiError(409, "moved"));
    wrap(<BeszelImport />);
    await waitFor(() => expect(screen.getByLabelText(messages.connect.url)).toBeTruthy());
    await connect();
    await screen.findByText(messages.review.title);
    fireEvent.click(screen.getByRole("button", { name: messages.apply.button }));
    expect((await screen.findByText(messages.apply.stale))).toBeTruthy();
    const before = (api.beszelPreview as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: messages.apply.refresh }));
    await waitFor(() => expect((api.beszelPreview as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before + 1));
    expect(api.beszelPreview).toHaveBeenLastCalledWith({ sessionId: "s1" });
    await waitFor(() => expect(screen.queryByText(messages.apply.stale)).toBeNull());
  });

  it("offers a kept connection and previews it without a sign-in", async () => {
    vi.spyOn(api, "beszelSessions").mockResolvedValue([{ sessionId: "k1", teamId: "t1", host: "beszel.example.com", expiresAt: "" }]);
    wrap(<BeszelImport />);
    const use = await screen.findByRole("button", { name: "Use beszel.example.com" });
    fireEvent.click(use);
    await screen.findByText(messages.review.title);
    expect(api.beszelPreview).toHaveBeenCalledWith({ sessionId: "k1" });
    expect(api.beszelConnect).not.toHaveBeenCalled();
  });

  it("never keeps the password in the form after connecting", async () => {
    wrap(<BeszelImport />);
    await waitFor(() => expect(screen.getByLabelText(messages.connect.url)).toBeTruthy());
    await connect();
    await screen.findByText(messages.review.title);
    expect(document.body.innerHTML).not.toContain("s3cret");
  });
});

describe("beszelImport i18n coverage", () => {
  const lookup = (tree: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);
  it("every literal beszelImport.* key in the component, its page and the import page exists", () => {
    const files = ["components/beszel-import.tsx", "app/(app)/import/beszel/page.tsx", "app/(app)/import/page.tsx"];
    const used = new Set<string>();
    for (const f of files) for (const m of readFileSync(path.resolve(__dirname, "..", f), "utf8").matchAll(/["'`](beszelImport\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(40);
    expect([...used].filter((k) => typeof lookup(messages, k.replace(/^beszelImport\./, "")) !== "string")).toEqual([]);
  });
  it("has no key that nothing references (no dead copy)", () => {
    const src = ["components/beszel-import.tsx", "app/(app)/import/beszel/page.tsx", "app/(app)/import/page.tsx"].map((f) => readFileSync(path.resolve(__dirname, "..", f), "utf8")).join("\n");
    const leaves: string[] = [];
    const walk = (n: unknown, p: string) => (typeof n === "string" ? leaves.push(p) : Object.entries(n as object).forEach(([k, v]) => walk(v, p ? `${p}.${k}` : k)));
    walk(messages, "");
    const dead = leaves.filter((k) => !src.includes(`beszelImport.${k}`));
    expect(dead).toEqual([]);
  });
});
