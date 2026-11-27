import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ServerScanCard, scanErrorKey } from "./server-scan-card";
import { api, ApiError } from "../lib/api";
import type { ScanReport } from "../lib/types";

afterEach(cleanup);

function report(over: Partial<ScanReport> = {}): ScanReport {
  return {
    v: 1,
    scannedAt: new Date(Date.now() - 120_000).toISOString(),
    host: { status: "ok", reason: null },
    docker: { available: true, total: 4, running: 3, tugra: 1, truncated: false },
    software: [
      { id: "coolify", label: "Coolify", kind: "platform", logo: null, count: 2, containers: ["coolify", "app-1"] },
      { id: "pm2", label: "PM2", kind: "runtime", logo: null, count: 2, containers: [] },
      { id: "redis", label: "Redis", kind: "database", logo: "redis", count: 2, containers: ["cache-a", "cache-b"] },
      { id: "postgres", label: "PostgreSQL", kind: "database", logo: "postgresql", count: 1, containers: ["db"] },
    ],
    containers: [
      { name: "coolify", image: "ghcr.io/coollabsio/coolify:4", state: "running", project: null, service: null, software: "coolify", managedBy: "coolify", ports: [], adoptable: false },
      { name: "cache-a", image: "redis:7", state: "running", project: null, service: null, software: "redis", managedBy: null, ports: [6379], adoptable: true },
      { name: "cache-b", image: "redis:7", state: "exited", project: null, service: null, software: "redis", managedBy: null, ports: [], adoptable: true },
      { name: "db", image: "postgres:16", state: "running", project: "shop", service: "db", software: "postgres", managedBy: null, ports: [], adoptable: false },
    ],
    composeProjects: [{ name: "shop", services: 1, running: 1 }],
    pm2: [{ user: "deploy", daemon: true, procs: [{ name: "api", script: "/srv/api/server.js", cwd: "/srv/api", status: "online", port: 3000, envCount: 4 }, { name: "worker", script: "", cwd: "", status: "stopped", envCount: 0 }] }],
    sites: [{ server: "nginx", names: ["a.example.com", "www.a.example.com"], root: "/home/x/htdocs/a.example.com", kind: "php", php: "8.2", ssl: true, panel: "cloudpanel" }],
    services: [{ unit: "nginx", kind: "web", enabled: true, running: true }],
    ports: [{ port: 22, scope: "public", owner: "SSH" }, { port: 3000, scope: "local", owner: null }],
    ...over,
  };
}

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.restoreAllMocks();
});

const show = (props: Partial<React.ComponentProps<typeof ServerScanCard>> = {}) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ServerScanCard serverId="s1" canOps canWrite online onReviewAdopt={() => {}} {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("ServerScanCard", () => {
  it("refreshes a report taken with an outdated agent once on open, and not again within the hour", async () => {
    sessionStorage.clear();
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report({ host: { status: "unavailable", reason: "agent_outdated" } }) });
    const run = vi.spyOn(api, "runServerScan").mockResolvedValue({ report: report() });
    show();
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    cleanup();
    show();
    await new Promise((r) => setTimeout(r, 50));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not auto-scan a fresh report or without server-ops", async () => {
    sessionStorage.clear();
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report() });
    const run = vi.spyOn(api, "runServerScan").mockResolvedValue({ report: report() });
    show();
    await screen.findByText("PM2");
    expect(run).not.toHaveBeenCalled();
  });

  it("offers the scan when the server was never scanned, and runs it on click", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: null });
    const run = vi.spyOn(api, "runServerScan").mockResolvedValue({ report: report() });
    show();
    expect(await screen.findByText(/Nothing on the server changes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scan this server" }));
    expect(await screen.findByRole("button", { name: "Scan again" })).toBeTruthy();
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Scanned 2m ago/)).toBeTruthy();
  });

  it("never scans on its own", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: null });
    const run = vi.spyOn(api, "runServerScan");
    show();
    await screen.findByText(/Nothing on the server changes/);
    expect(run).not.toHaveBeenCalled();
  });

  it("disables the scan for a member without server-ops and for an offline server, with the reason", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: null });
    show({ canOps: false });
    const btn = await screen.findByRole("button", { name: "Scan this server" });
    expect(btn).toHaveProperty("disabled", true);
    expect(btn.getAttribute("title")).toBe("You need server-ops permission to scan");
    cleanup();
    show({ online: false });
    const off = await screen.findByRole("button", { name: "Scan this server" });
    expect(off).toHaveProperty("disabled", true);
    expect(off.getAttribute("title")).toBe("The server is offline");
  });

  it("renders the software strip with counts and the sections", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report() });
    show();
    const strip = await screen.findByRole("list", { name: "Software on this server" });
    const chips = within(strip).getAllByRole("button");
    expect(chips).toHaveLength(4);
    expect(within(chips[0]).getByText("Coolify")).toBeTruthy();
    expect(within(chips[0]).getByText("×2")).toBeTruthy();
    expect(within(chips[3]).queryByText(/×/)).toBeNull(); // a single instance shows no count
    expect(screen.getByText("Containers (4)")).toBeTruthy();
    expect(screen.getByText("PM2 processes")).toBeTruthy();
    expect(screen.getByText("a.example.com")).toBeTruthy();
    expect(screen.getByText("PHP 8.2")).toBeTruthy();
    expect(screen.getByText("Listening ports")).toBeTruthy();
    // a software logo is decorative: hidden from assistive tech, the label sits next to it
    expect(chips[2].querySelector("[aria-hidden]")).toBeTruthy();
  });

  it("puts the brand icon of the image on each container row, and a plain glyph when the image is unknown", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({
      report: report({ containers: [
        { name: "cache-a", image: "redis:7", state: "running", project: null, service: null, software: "redis", managedBy: null, ports: [], adoptable: true },
        { name: "db", image: "docker.io/library/postgres:16-alpine", state: "running", project: null, service: null, software: null, managedBy: null, ports: [], adoptable: false },
        { name: "billing", image: "ghcr.io/acme/billing:1", state: "running", project: null, service: null, software: null, managedBy: null, ports: [], adoptable: false },
      ] }),
    });
    show();
    const row = async (name: string) => (await screen.findByText(name)).parentElement as HTMLElement;
    expect((await row("cache-a")).querySelector("img")?.getAttribute("src")).toBe("/icons/redis.svg");
    expect((await row("db")).querySelector("img")?.getAttribute("src")).toBe("/icons/postgresql.svg");
    const plain = await row("billing");
    expect(plain.querySelector("img")).toBeNull();
    expect(plain.querySelector("svg")).not.toBeNull();
    expect((await row("cache-a")).querySelector("img")?.getAttribute("width")).toBe("20");
  });

  it("filters the lists to one software when its chip is clicked, and clears", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report() });
    show();
    const redis = await screen.findByRole("button", { name: /Redis/ });
    fireEvent.click(redis);
    expect(redis.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Containers (2)")).toBeTruthy();
    expect(screen.queryByText("PM2 processes")).toBeNull();
    expect(screen.queryByText("Listening ports")).toBeNull();
    expect(screen.getByText("Showing Redis")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText("Containers (4)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /PM2/ }));
    expect(screen.getByText("PM2 processes")).toBeTruthy();
    expect(screen.queryByText(/^Containers \(/)).toBeNull();
  });

  it("lists complete next steps: adopt, Coolify itself stays, PM2 owner-only, websites stay", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report() });
    const onReviewAdopt = vi.fn();
    show({ onReviewAdopt });
    expect(await screen.findByText("2 containers can be adopted as Tugra apps.")).toBeTruthy();
    expect(screen.getByText(/1 compose stack can be adopted as one app/)).toBeTruthy();
    // the only Coolify container is Coolify's own: nothing to move, and no "move with the import" promise
    expect(screen.getByText(/This server runs Coolify itself\./)).toBeTruthy();
    expect(screen.queryByTestId("platform-move-coolify")).toBeNull();
    // Coolify itself runs here: reading it through the agent is the primary path, no token claim
    expect(screen.getByRole("link", { name: "Read this Coolify" }).getAttribute("href")).toBe("/import/coolify-host?server=s1");
    expect(screen.queryByText(/API token\./)).toBeNull();
    expect(screen.getByText("Only the instance owner can move PM2 processes to Tugra.")).toBeTruthy();
    expect(screen.getByText(/Websites on nginx, Apache or CloudPanel stay where they are/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to Tugra" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReviewAdopt).toHaveBeenCalledTimes(1);
  });

  it("apps a platform deployed say what is needed and open the import with the platform", async () => {
    const rep = report({
      containers: [
        { name: "coolify", image: "ghcr.io/coollabsio/coolify:4", state: "running", project: null, service: null, software: "coolify", managedBy: "coolify", ports: [], adoptable: false, platformInfra: true },
        { name: "abc-1", image: "node:22", state: "running", project: "abc", service: "app", software: null, managedBy: "coolify", ports: [], adoptable: false, platformInfra: false },
        { name: "def-2", image: "node:22", state: "running", project: "def", service: "app", software: null, managedBy: "coolify", ports: [], adoptable: false, platformInfra: false },
      ],
    });
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: rep });
    sessionStorage.clear();
    show({ serverName: "Box 1" });
    const block = await screen.findByTestId("platform-move-coolify");
    expect(block.textContent).toContain("2 apps are deployed by Coolify.");
    // no claim that a token is needed: the agent path reads the Coolify itself
    expect(block.textContent).not.toMatch(/you need a Coolify API token/);
    expect(block.textContent).toContain("Tugra reads them from Coolify itself, through its agent.");
    expect(screen.getByText(/Coolify itself \(1 container\) stays where it is/)).toBeTruthy();
    // the real config is not on this server: reading the Coolify host that this very server runs is the primary path, the token import a quiet link
    const read = within(block).getByRole("link", { name: "Read this Coolify" });
    expect(read.getAttribute("href")).toBe("/import/coolify-host?server=s1");
    expect(read.getAttribute("style")).toContain("var(--c-a)"); // primary chrome
    expect(within(block).queryByRole("link", { name: "Use your Coolify API token" })).toBeNull();
    const token = within(block).getByRole("link", { name: "Or use a Coolify API token instead" });
    expect(token.getAttribute("href")).toBe("/import");
    fireEvent.click(token);
    expect(JSON.parse(sessionStorage.getItem("tugra.import.focus") ?? "{}")).toEqual({ kind: "coolify", fromServerName: "Box 1" });
    // compose projects of platform apps are not offered as stacks to adopt
    expect(screen.queryByText(/compose stack/)).toBeNull();
  });

  it("Coolify apps whose Coolify is not on this server lead with connecting it, token stays secondary", async () => {
    const rep = report({
      containers: [{ name: "abc-1", image: "node:22", state: "running", project: "abc", service: "app", software: null, managedBy: "coolify", ports: [], adoptable: false, platformInfra: false }],
    });
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: rep });
    show();
    const block = await screen.findByTestId("platform-move-coolify");
    expect(block.textContent).not.toMatch(/you need a Coolify API token/);
    expect(within(block).getByRole("link", { name: "Connect your Coolify server" }).getAttribute("href")).toBe("/import/coolify-host");
    expect(within(block).getByRole("link", { name: "Or use a Coolify API token instead" }).getAttribute("href")).toBe("/import");
  });

  it("Dokploy apps use the Dokploy import and never offer Read this Coolify", async () => {
    const rep = report({
      containers: [{ name: "web", image: "nginx", state: "running", project: null, service: null, software: null, managedBy: "dokploy", ports: [], adoptable: false, platformInfra: false }],
    });
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: rep });
    show();
    const block = await screen.findByTestId("platform-move-dokploy");
    expect(within(block).getByRole("link", { name: "Use your Dokploy API token" })).toBeTruthy();
    expect(within(block).queryByRole("link", { name: /Coolify/ })).toBeNull();
  });

  it("Swarm services point at the Dokploy import and are not offered for adoption", async () => {
    const rep = report({ containers: [{ name: "w.1.x", image: "nginx", state: "running", project: null, service: null, software: null, managedBy: null, ports: [], adoptable: false, swarm: true }] });
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: rep });
    show();
    expect(await screen.findByText(/1 container is a Swarm service, often a Dokploy app/)).toBeTruthy();
    expect(screen.queryByText(/can be adopted as Tugra apps/)).toBeNull();
  });

  it("Review is disabled with the reason when the server is offline, read-only or lacks the deploy capability", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report() });
    show({ online: false });
    expect(await screen.findByText("This server is offline. Bring its agent back online first.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toHaveProperty("disabled", true);
    cleanup();
    show({ capabilities: ["backup"] });
    expect(await screen.findByText(/Needs the Deploy apps capability on this server\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Turn it on" }).getAttribute("href")).toBe("/servers/s1?tab=maintenance");
    expect(screen.getByRole("button", { name: "Review" })).toHaveProperty("disabled", true);
  });

  it("a read-only member sees why Review is off instead of nothing", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report() });
    show({ canWrite: false });
    expect(await screen.findByText("You can view this server but not change it. Ask a team owner or admin.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toHaveProperty("disabled", true);
  });

  it.each([
    ["agent_outdated", /Update this server's agent to scan the host too/],
    ["failed", /Couldn't read the host this time/],
    ["no_image", /doesn't know its own image/],
  ] as const)("explains a missing host part (%s)", async (reason, text) => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report({ host: { status: "unavailable", reason }, pm2: [], sites: [], services: [], ports: [] }) });
    show();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByText("Containers (4)")).toBeTruthy();
  });

  it("says when docker is missing and when nothing is recognisable", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({
      report: report({ docker: { available: false, total: 0, running: 0, tugra: 0, truncated: false }, software: [], containers: [], composeProjects: [], pm2: [], sites: [], services: [], ports: [] }),
    });
    show();
    expect(await screen.findByText("Docker isn't installed on this server.")).toBeTruthy();
    expect(screen.getByText("Nothing recognisable found.")).toBeTruthy();
  });

  it("renders hostile names as text, never markup", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report({ containers: [{ name: evil, image: "x", state: "running", project: null, service: null, software: null, managedBy: null, ports: [], adoptable: false }] }) });
    const { container } = show();
    expect(await screen.findByText(evil)).toBeTruthy();
    expect(container.querySelector("img[onerror]")).toBeNull();
  });

  it("shows a typed error when the scan fails", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: null });
    vi.spyOn(api, "runServerScan").mockRejectedValue(new ApiError(503, "x"));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Scan this server" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't scan this server. Check that its agent is online.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan this server" })).toHaveProperty("disabled", false));
  });

  it("maps errors to keys", () => {
    expect(scanErrorKey(new ApiError(403, "x"))).toBe("errForbidden");
    expect(scanErrorKey(new ApiError(503, "x"))).toBe("errUnavailable");
    expect(scanErrorKey(new Error("x"))).toBe("errGeneric");
  });

  it("puts a warning card with severity and fix hints at the top when public data stores were found", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({
      report: report({
        exposed: [
          { port: 6482, service: "Redis", kind: "cache", severity: "critical", container: "cache-a", basis: "container", fix: "publish_local" },
          { port: 3306, service: "MySQL / MariaDB", kind: "database", severity: "high", container: null, basis: "port", fix: "bind_local" },
          { port: 2375, service: "Docker API (no TLS)", kind: "docker", severity: "critical", container: null, basis: "port", fix: "docker_api" },
        ],
      }),
    });
    show();
    const card = await screen.findByTestId("exposed-services");
    expect(within(card).getByText("3 services listen on all interfaces")).toBeTruthy();
    expect(within(card).getByText("Redis")).toBeTruthy();
    expect(within(card).getAllByText("Critical").length).toBe(2);
    expect(within(card).getByText(/"127\.0\.0\.1:6482:6482"/)).toBeTruthy();
    expect(within(card).getByText(/Bind the service to 127\.0\.0\.1/)).toBeTruthy();
    expect(within(card).getByText(/Remove the tcp:\/\/ listener/)).toBeTruthy();
    expect(within(card).getAllByText("Identified by its port number").length).toBe(2);
    // the card comes before everything else in the result
    expect(card.compareDocumentPosition(screen.getByLabelText("Software on this server") as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // no automatic action: the card has no buttons
    expect(within(card).queryAllByRole("button").length).toBe(0);
  });

  it("says the exposure could not be checked when the host half is unavailable, and labels an account-identified service", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report({ host: { status: "unavailable", reason: "agent_outdated" }, exposed: [] }) });
    show();
    expect(await screen.findByTestId("exposed-unchecked")).toHaveProperty("textContent", expect.stringMatching(/could not be checked/));
    expect(screen.queryByTestId("exposed-services")).toBeNull();
    cleanup();
    vi.spyOn(api, "getServerScan").mockResolvedValue({
      report: report({ exposed: [{ port: 6482, service: "Redis", kind: "cache", severity: "critical", container: null, basis: "account", fix: "bind_local" }] }),
    });
    show();
    const card = await screen.findByTestId("exposed-services");
    expect(within(card).getByText("Identified by the account it runs as")).toBeTruthy();
    expect(screen.queryByTestId("exposed-unchecked")).toBeNull();
  });

  it("shows no warning when nothing is exposed or the report predates the check", async () => {
    vi.spyOn(api, "getServerScan").mockResolvedValue({ report: report({ exposed: [] }) });
    show();
    await screen.findByRole("button", { name: "Scan again" });
    expect(screen.queryByTestId("exposed-services")).toBeNull();
  });
});
