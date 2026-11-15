import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { I18nProvider } from "../../i18n/provider";
import en from "../../i18n/locales/en";
import { translate } from "../../i18n/translate";
import { ConfirmProvider } from "../confirm";
import { api } from "../../lib/api";
import type { AppDrainSummary, DrainDelivery, LogDrain } from "../../lib/types";
import { LogDrainCard } from "./log-drain-card";
import type { DrainScope } from "./drain-form";

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
  vi.spyOn(api, "listLogDrains").mockResolvedValue([]);
  vi.spyOn(api, "listAppLogDrains").mockResolvedValue([]);
  vi.spyOn(api, "listServerAppDrains").mockResolvedValue([]);
});

const wrap = (scope: DrainScope) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <LogDrainCard scope={scope} />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const SERVER: DrainScope = { kind: "server", id: "s1" };
const APP_IMAGE: DrainScope = { kind: "app", id: "a1", isCompose: false, clustered: false };
const APP_COMPOSE: DrainScope = { kind: "app", id: "a1", isCompose: true, clustered: false };
const APP_SWARM_COMPOSE: DrainScope = { kind: "app", id: "a1", isCompose: true, clustered: true };

const drain = (over: Partial<LogDrain> = {}): LogDrain => ({
  id: "d1", name: "axiom", type: "loki", endpoint: "https://logs.example.com/push", enabled: true, hasToken: true, createdAt: "2026-11-15T00:00:00Z",
  scope: "app", appId: "a1", containers: [], options: null, allowPrivate: false, delivery: "ok", status: null, ...over,
});

const pickType = (value: string) => fireEvent.change(screen.getByLabelText("Type"), { target: { value } });

describe("LogDrainCard: field switching per type", () => {
  it("http shows URL + bearer only", () => {
    wrap(SERVER);
    expect(screen.getByLabelText("Endpoint URL")).toBeTruthy();
    expect(screen.getByLabelText("Bearer token (optional)")).toBeTruthy();
    expect(screen.queryByLabelText("Protocol")).toBeNull();
    expect(screen.queryByLabelText("Host")).toBeNull();
  });

  it("syslog shows protocol/host/port/facility/app name, framing only off UDP, and a UDP warning", () => {
    wrap(SERVER);
    pickType("syslog");
    expect(screen.queryByLabelText("Endpoint URL")).toBeNull();
    for (const l of ["Protocol", "Host", "Port", "Facility (0-23)", "App name (optional)"]) expect(screen.getByLabelText(l)).toBeTruthy();
    expect(screen.queryByLabelText("Framing")).toBeNull(); // UDP: no framing
    expect(screen.getByText(/UDP is fire-and-forget/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "tcp" } });
    expect(screen.getByLabelText("Framing")).toBeTruthy();
    expect(screen.queryByText(/UDP is fire-and-forget/)).toBeNull();
    expect(screen.queryByLabelText("CA certificate (PEM, optional)")).toBeNull(); // TLS-only
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "tls" } });
    expect(screen.getByLabelText("CA certificate (PEM, optional)")).toBeTruthy();
    expect(screen.getByLabelText("TLS server name (optional)")).toBeTruthy();
  });

  it("gelf: compression is offered for UDP only", () => {
    wrap(SERVER);
    pickType("gelf");
    expect(screen.getByLabelText("Compression")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "tcp" } });
    expect(screen.queryByLabelText("Compression")).toBeNull();
  });

  it("fluentd: tag, acknowledgement and the shared key; no UDP protocol", () => {
    wrap(SERVER);
    pickType("fluentd");
    expect(screen.getByLabelText("Tag prefix")).toBeTruthy();
    expect(screen.getByLabelText("Shared key (optional)")).toBeTruthy();
    expect(screen.getByLabelText("Require acknowledgement")).toBeTruthy();
    const protos = within(screen.getByLabelText("Protocol")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(protos).toEqual(["", "tcp", "tls"]); // "" is the disabled placeholder; no udp
  });
});

describe("LogDrainCard: container filter", () => {
  it("server scope: glob filter field", () => {
    wrap(SERVER);
    expect(screen.getByLabelText("Container filter")).toBeTruthy();
    expect(screen.getByText(/Container name patterns/)).toBeTruthy();
  });

  it("app scope + non-clustered compose: service filter field", () => {
    wrap(APP_COMPOSE);
    expect(screen.getByLabelText("Container filter")).toBeTruthy();
    expect(screen.getByText(/Compose services to ship/)).toBeTruthy();
  });

  it.each([
    ["an image app", APP_IMAGE],
    ["a swarm-clustered compose app", APP_SWARM_COMPOSE],
  ])("%s: no filter field, an explanation instead", (_n, scope) => {
    wrap(scope);
    expect(screen.queryByLabelText("Container filter")).toBeNull();
    expect(screen.getByText(/only applies to compose apps that are not deployed to a swarm/)).toBeTruthy();
  });

  it("adds services as chips, rejects an invalid one, and removes a chip", () => {
    wrap(APP_COMPOSE);
    const input = screen.getByLabelText("Container filter");
    fireEvent.change(input, { target: { value: "Bad Name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toMatch(/Compose service names/);
    fireEvent.change(input, { target: { value: "web" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("web")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove web"));
    expect(screen.queryByText("web")).toBeNull();
  });
});

describe("LogDrainCard: create payloads", () => {
  it("app scope posts to the APP api with allowPrivate false and the filter", async () => {
    const create = vi.spyOn(api, "createAppLogDrain").mockResolvedValue(drain());
    const createServer = vi.spyOn(api, "createLogDrain");
    wrap(APP_COMPOSE);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "axiom" } });
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "https://logs.example.com/in" } });
    const filter = screen.getByLabelText("Container filter");
    fireEvent.change(filter, { target: { value: "web" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "+ Add drain" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith("a1", { name: "axiom", type: "http", endpoint: "https://logs.example.com/in", containers: ["web"], allowPrivate: false });
    expect(createServer).not.toHaveBeenCalled();
  });

  it("the allowPrivate checkbox is app scope only and is sent when ticked", async () => {
    const create = vi.spyOn(api, "createAppLogDrain").mockResolvedValue(drain());
    wrap(APP_IMAGE);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "lan" } });
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "http://10.0.0.5:3100/loki" } });
    fireEvent.click(screen.getByLabelText("Allow private network targets"));
    fireEvent.click(screen.getByRole("button", { name: "+ Add drain" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][1]).toMatchObject({ allowPrivate: true });
    cleanup();
    wrap(SERVER);
    expect(screen.queryByLabelText("Allow private network targets")).toBeNull();
  });

  it("server scope posts a syslog drain to the SERVER api with host:port + options", async () => {
    const create = vi.spyOn(api, "createLogDrain").mockResolvedValue(drain({ scope: "server", appId: null }));
    wrap(SERVER);
    pickType("syslog");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "rsyslog" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "logs.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add drain" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith("s1", {
      name: "rsyslog", type: "syslog", endpoint: "logs.example.com:514", containers: [], options: { proto: "udp", facility: 16 },
    });
  });

  it("explains an invalid draft locally and never calls the API", async () => {
    const create = vi.spyOn(api, "createLogDrain");
    wrap(SERVER);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "ftp://x" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add drain" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/http:\/\/ or https:\/\//);
    expect(create).not.toHaveBeenCalled();
  });

  it("surfaces a 403 from the API inline", async () => {
    vi.spyOn(api, "createAppLogDrain").mockRejectedValue(new Error("insufficient permission for this team"));
    wrap(APP_IMAGE);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "lan" } });
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "http://10.0.0.5/x" } });
    fireEvent.click(screen.getByLabelText("Allow private network targets"));
    fireEvent.click(screen.getByRole("button", { name: "+ Add drain" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/insufficient permission/);
  });
});

describe("LogDrainCard: rows", () => {
  it("token blank keeps: saving an edit without typing a token sends no token key", async () => {
    vi.spyOn(api, "listAppLogDrains").mockResolvedValue([drain({ hasToken: true })]);
    const update = vi.spyOn(api, "updateAppLogDrain").mockResolvedValue(drain());
    wrap(APP_IMAGE);
    fireEvent.click(await screen.findByLabelText("Edit"));
    const nameInputs = screen.getAllByLabelText("Name");
    fireEvent.change(nameInputs[0], { target: { value: "renamed" } });
    expect(screen.getAllByPlaceholderText("Token set — blank to keep").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const body = update.mock.calls[0][2];
    expect(update.mock.calls[0][0]).toBe("a1");
    expect(update.mock.calls[0][1]).toBe("d1");
    expect(body).toMatchObject({ name: "renamed", type: "loki" });
    expect("token" in body).toBe(false);
  });

  it("toggling enabled sends just { enabled }", async () => {
    vi.spyOn(api, "listLogDrains").mockResolvedValue([drain({ scope: "server", appId: null })]);
    const update = vi.spyOn(api, "updateLogDrain").mockResolvedValue(drain());
    wrap(SERVER);
    fireEvent.click(await screen.findByLabelText("axiom"));
    await waitFor(() => expect(update).toHaveBeenCalledWith("s1", "d1", { enabled: false }));
  });

  it.each<[DrainDelivery, string]>([
    ["ok", "Delivering"],
    ["pending", "Waiting for first delivery"],
    ["offline", "Agent offline"],
    ["agent_outdated", "Agent update required"],
    ["capability_revoked", "Logs capability revoked"],
    ["disabled", "Disabled"],
    ["error", "Delivery failing"],
    ["invalid", "Invalid configuration"],
  ])("delivery badge: %s", async (delivery, text) => {
    vi.spyOn(api, "listAppLogDrains").mockResolvedValue([drain({ delivery, status: delivery === "error" ? { sent: 12, dropped: 3, errClass: "tls", lastOkAt: "2026-11-15T10:00:00Z" } : null })]);
    wrap(APP_IMAGE);
    expect(await screen.findByText(text)).toBeTruthy();
    if (delivery === "error") {
      expect(screen.getByText(/12 lines sent, 3 dropped/)).toBeTruthy();
      expect(screen.getByText(/TLS verification failed/)).toBeTruthy();
    }
  });
});

describe("LogDrainCard: server scope lists the app drains shipping from the server (read-only, no endpoint)", () => {
  it("renders name, type, app link and delivery; offers no edit controls for them", async () => {
    const rows: AppDrainSummary[] = [{ id: "ad1", name: "shop-logs", type: "loki", enabled: true, appId: "app9", appName: "Shop", delivery: "error" }];
    vi.spyOn(api, "listServerAppDrains").mockResolvedValue(rows);
    wrap(SERVER);
    expect(await screen.findByText("shop-logs")).toBeTruthy();
    expect(screen.getByText("App drains shipping from this server")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open app Shop" });
    expect(link.getAttribute("href")).toBe("/apps/app9");
    expect(screen.getByText("Delivery failing")).toBeTruthy();
    expect(screen.queryByLabelText("Edit")).toBeNull();
  });

  it("is not rendered for an app scope, which shows the preview/clone note instead", () => {
    wrap(APP_IMAGE);
    expect(screen.queryByText("App drains shipping from this server")).toBeNull();
    expect(screen.getByText(/Preview deployments, clones and config snapshots do not include log drains/)).toBeTruthy();
  });
});

describe("i18n coverage", () => {
  const dir = __dirname;
  const sources = ["drain-form.tsx", "drain-row.tsx", "log-drain-card.tsx", "drain-model.ts"].map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

  it("every static logdrains.* key used in the components exists in en/logdrains.json", () => {
    const keys = new Set([...sources.matchAll(/["'`](logdrains\.[A-Za-z_]+)["'`]/g)].map((m) => m[1]));
    expect(keys.size).toBeGreaterThan(20);
    for (const k of keys) expect(translate(en, k), k).not.toBe(k);
  });

  it("every dynamically-built key resolves (type_*, proto_*, compress_*, delivery_*, err_*)", () => {
    const groups: Record<string, string[]> = {
      type_: ["http", "loki", "datadog", "syslog", "gelf", "fluentd"],
      proto_: ["udp", "tcp", "tls"],
      compress_: ["none", "gzip", "zlib"],
      framing_: ["octet", "newline"],
      delivery_: ["ok", "pending", "offline", "agent_outdated", "capability_revoked", "disabled", "error", "invalid"],
      err_: ["dns", "dial", "tls", "timeout", "refused", "http", "write", "ack", "policy", "config", "overflow"],
      scope_: ["server", "app"],
    };
    for (const [prefix, vals] of Object.entries(groups)) for (const v of vals) expect(translate(en, `logdrains.${prefix}${v}`), `${prefix}${v}`).not.toBe(`logdrains.${prefix}${v}`);
  });

  it("no JSX text in the card components is hard-coded English (everything goes through t())", () => {
    // crude guard: a quoted capitalised sentence passed as a prop/child would be a literal; the components must only carry t() calls
    for (const f of ["drain-form.tsx", "drain-row.tsx", "log-drain-card.tsx"]) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src.match(/>\s*[A-Z][a-z]+(?: [a-z]+)+\s*</g) ?? [], f).toEqual([]);
    }
  });
});
