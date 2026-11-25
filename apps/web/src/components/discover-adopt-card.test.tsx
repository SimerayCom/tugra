import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { DiscoverAdoptCard } from "./discover-adopt-card";
import { api } from "../lib/api";
import type { DiscoveredContainer, DiscoveredStack } from "../lib/types";

afterEach(cleanup);

function dc(over: Partial<DiscoveredContainer> = {}): DiscoveredContainer {
  return {
    id: "cid",
    name: "legacy-web",
    image: "nginx:1.25",
    state: "running",
    ports: [{ host: 8080, container: 80, protocol: "tcp" }],
    env: [{ key: "APP_ENV", value: "prod" }],
    mounts: [],
    restartPolicy: "no",
    isTugra: false,
    composeProject: null,
    adoptable: true,
    ...over,
  };
}

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("DiscoverAdoptCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("scans and lists foreign containers; compose ones are not adoptable", async () => {
    vi.spyOn(api, "discoverContainers").mockResolvedValue({
      containers: [dc(), dc({ id: "c2", name: "stack-db-1", image: "postgres:16", composeProject: "stack", adoptable: false })],
    });
    wrap(<DiscoverAdoptCard id="s1" />);
    fireEvent.click(screen.getByText("Scan"));
    await waitFor(() => expect(screen.getByText("legacy-web")).toBeTruthy());
    expect(screen.getByText("stack-db-1")).toBeTruthy();
    // adoptable row → an Adopt button; compose row → a "not yet" badge instead
    expect(screen.getByText(/compose/)).toBeTruthy();
    expect(screen.getAllByText("Adopt").length).toBe(1);
  });

  it("tells the user Tugra's own containers are never listed", () => {
    wrap(<DiscoverAdoptCard id="s1" />);
    expect(screen.getByText(/Tugra's own containers are never listed/)).toBeTruthy();
  });

  it("shows an empty state when nothing unmanaged is found", async () => {
    vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: [] });
    wrap(<DiscoverAdoptCard id="s1" />);
    fireEvent.click(screen.getByText("Scan"));
    await waitFor(() => expect(screen.getByText(/No unmanaged containers/)).toBeTruthy());
  });

  it("opens a prefilled adopt modal with the data warning and submits the adoption", async () => {
    vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: [dc()] });
    const adoptSpy = vi.spyOn(api, "adoptContainer").mockResolvedValue({ id: "app1" } as never);
    wrap(<DiscoverAdoptCard id="s1" />);
    fireEvent.click(screen.getByText("Scan"));
    await waitFor(() => expect(screen.getByText("Adopt")).toBeTruthy());

    fireEvent.click(screen.getByText("Adopt")); // row → open modal
    const dialog = await screen.findByRole("dialog");
    // prefilled name
    expect((within(dialog).getByDisplayValue("legacy-web") as HTMLInputElement).value).toBe("legacy-web");
    // the loud "data not migrated" warning is present
    expect(within(dialog).getByText(/redeploy from Tugra recreates it/)).toBeTruthy();

    // submit (the modal's Adopt button)
    fireEvent.click(within(dialog).getByText("Adopt"));
    await waitFor(() =>
      expect(adoptSpy).toHaveBeenCalledWith("s1", { container: "legacy-web", name: "legacy-web", portIndex: 0, envKeys: ["APP_ENV"] }),
    );
  });

  describe("adopt a whole compose stack", () => {
    const stack = (over: Partial<DiscoveredStack> = {}): DiscoveredStack => ({
      project: "shop",
      workingDir: "/srv/shop",
      configFiles: ["/srv/shop/docker-compose.yml"],
      services: [
        { service: "db", image: "postgres:16", ports: [], state: "running", containers: 1 },
        { service: "web", image: "node:22", ports: [8080], state: "running", containers: 1 },
      ],
      volumes: [{ service: "db", name: "shop_pgdata", target: "/var/lib/postgresql/data" }],
      firstContainer: "shop-web-1",
      adoptable: true,
      reason: null,
      managedBy: null,
      ...over,
    });
    const members = [
      dc({ id: "c1", name: "shop-web-1", image: "node:22", composeProject: "shop", adoptable: false }),
      dc({ id: "c2", name: "shop-db-1", image: "postgres:16", composeProject: "shop", adoptable: false }),
    ];
    const owner = () => vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", role: "OWNER" }] as never);

    it("puts 'Adopt stack' on the first member row only, with a preview of the services", async () => {
      owner();
      vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: members, stacks: [stack()] });
      wrap(<DiscoverAdoptCard id="s1" teamId="t1" />);
      fireEvent.click(screen.getByText("Scan"));
      await screen.findByText("shop-web-1");
      await waitFor(() => expect(screen.getAllByText("Adopt stack").length).toBe(1));
      const rows = screen.getAllByRole("row");
      const first = rows.find((r) => within(r).queryByText("shop-web-1"))!;
      const second = rows.find((r) => within(r).queryByText("shop-db-1"))!;
      expect(within(first).getByText("Adopt stack")).toBeTruthy();
      expect(within(first).getByTestId("stack-preview").textContent).toContain("2 services (db, web)");
      expect(within(second).queryByText("Adopt stack")).toBeNull();
      expect(within(second).getByText("Part of a compose stack")).toBeTruthy();
    });

    it("opens a preview and adopts the stack by project name", async () => {
      owner();
      vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: members, stacks: [stack()] });
      const adopt = vi.spyOn(api, "adoptStack").mockResolvedValue({ id: "app1" } as never);
      wrap(<DiscoverAdoptCard id="s1" teamId="t1" />);
      fireEvent.click(screen.getByText("Scan"));
      fireEvent.click(await screen.findByText("Adopt stack"));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByTestId("stack-services").textContent).toContain("postgres:16");
      expect(within(dialog).getByText("/srv/shop/docker-compose.yml")).toBeTruthy();
      expect(within(dialog).getByText(/Nothing is renamed, stopped or recreated/)).toBeTruthy();
      expect(within(dialog).getByText(/never copied or rewritten/)).toBeTruthy();
      fireEvent.change(within(dialog).getByDisplayValue("shop"), { target: { value: "Shop" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Adopt stack" }));
      await waitFor(() => expect(adopt).toHaveBeenCalledWith("s1", { project: "shop", name: "Shop" }));
    });

    it("offers no button to a member (non-owner/admin) and says why", async () => {
      vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", role: "VIEWER" }] as never);
      vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: members, stacks: [stack()] });
      wrap(<DiscoverAdoptCard id="s1" teamId="t1" />);
      fireEvent.click(screen.getByText("Scan"));
      await screen.findByText("shop-web-1");
      expect(screen.queryByText("Adopt stack")).toBeNull();
      const tip = screen.getAllByText("Part of a compose stack")[0].closest("span[data-tip]");
      expect(tip?.getAttribute("data-tip")).toMatch(/owners and admins/);
    });

    it("a refused stack (managed by another platform) keeps the badge with the reason", async () => {
      owner();
      vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: members, stacks: [stack({ adoptable: false, reason: "tugra" })] });
      wrap(<DiscoverAdoptCard id="s1" teamId="t1" />);
      fireEvent.click(screen.getByText("Scan"));
      await screen.findByText("shop-web-1");
      expect(screen.queryByText("Adopt stack")).toBeNull();
      expect(screen.getAllByText("Part of a compose stack")[0].closest("span[data-tip]")?.getAttribute("data-tip")).toMatch(/part of Tugra/);
    });

    it("an older hub without stacks still renders the compose badge", async () => {
      vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: members });
      wrap(<DiscoverAdoptCard id="s1" teamId="t1" />);
      fireEvent.click(screen.getByText("Scan"));
      await screen.findByText("shop-web-1");
      expect(screen.getAllByText("Part of a compose stack").length).toBe(2);
    });
  });

  describe("honest actions", () => {
    const srv: { name: string; status: "ONLINE" | "OFFLINE" | "PENDING"; canWrite: boolean; capabilities: string[] } = { name: "Box 1", status: "ONLINE", canWrite: true, capabilities: ["deploy"] };

    it("platform apps carry the platform into the import and say a token is needed; its own stack is not moved", async () => {
      sessionStorage.clear();
      vi.spyOn(api, "discoverContainers").mockResolvedValue({
        containers: [
          dc({ id: "a", name: "coolify-proxy", image: "traefik:v3", managedBy: "coolify", platformInfra: true, adoptable: false }),
          dc({ id: "b", name: "abc-1", image: "node:22", managedBy: "coolify", platformInfra: false, adoptable: false }),
        ],
      });
      wrap(<DiscoverAdoptCard id="s1" server={srv} />);
      fireEvent.click(screen.getByText("Scan"));
      await screen.findByText("abc-1");
      const rows = screen.getAllByRole("row");
      const infra = rows.find((r) => within(r).queryByText("coolify-proxy"))!;
      const app = rows.find((r) => within(r).queryByText("abc-1"))!;
      expect(within(infra).getByText("Part of Coolify itself. Not moved.")).toBeTruthy();
      expect(within(infra).queryByRole("link")).toBeNull();
      expect(within(app).getByText("Needs the Coolify import and an API token.")).toBeTruthy();
      fireEvent.click(within(app).getByRole("link", { name: /Open the import/ }));
      expect(JSON.parse(sessionStorage.getItem("tugra.import.focus") ?? "{}")).toEqual({ kind: "coolify", fromServerName: "Box 1" });
    });

    it("a Swarm service is refused with the Dokploy import as the way", async () => {
      vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: [dc({ id: "w", name: "web.1.x", swarm: true, adoptable: false })] });
      wrap(<DiscoverAdoptCard id="s1" server={srv} />);
      fireEvent.click(screen.getByText("Scan"));
      await screen.findByText("web.1.x");
      expect(screen.getByText(/This container is a Swarm service \(often Dokploy\)/)).toBeTruthy();
      expect(screen.queryByText("Adopt")).toBeNull();
    });

    it("Adopt and Scan are off with the reason when the server is offline or lacks the deploy capability", async () => {
      vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: [dc()] });
      wrap(<DiscoverAdoptCard id="s1" server={{ ...srv, status: "OFFLINE" }} />);
      expect(screen.getByText("This server is offline. Bring its agent back online first.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Scan" })).toHaveProperty("disabled", true);
      cleanup();
      wrap(<DiscoverAdoptCard id="s1" server={{ ...srv, capabilities: ["backup"] }} />);
      expect(screen.getByText(/Needs the Deploy apps capability/)).toBeTruthy();
      expect(screen.getByRole("link", { name: "Turn it on" }).getAttribute("href")).toBe("/servers/s1?tab=maintenance");
    });

    it("a stack the platform runs shows its reason in plain sight with the import link", async () => {
      vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", role: "OWNER" }] as never);
      vi.spyOn(api, "discoverContainers").mockResolvedValue({
        containers: [dc({ id: "c1", name: "shop-web-1", composeProject: "shop", adoptable: false }), dc({ id: "c2", name: "shop-db-1", composeProject: "shop", adoptable: false })],
        stacks: [{ project: "shop", services: [], workingDir: "/srv/shop", configFiles: [], volumes: [], firstContainer: "shop-web-1", adoptable: false, reason: "managed", managedBy: "coolify" } as never],
      });
      wrap(<DiscoverAdoptCard id="s1" teamId="t1" server={srv} />);
      fireEvent.click(screen.getByText("Scan"));
      const refusal = await screen.findByTestId("stack-refusal");
      expect(refusal.textContent).toMatch(/Coolify or Dokploy runs this project/);
      expect(within(refusal).getByRole("link", { name: "Open the import" })).toBeTruthy();
    });
  });
});
