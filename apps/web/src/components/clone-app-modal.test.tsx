import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ToastProvider } from "./toast";
import { CloneAppModal } from "./clone-app-modal";
import { api } from "../lib/api";
import type { Application, Project, ServerView } from "../lib/types";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

afterEach(cleanup);

const SERVERS = [
  { id: "s1", name: "prod" },
  { id: "s2", name: "edge" },
] as unknown as ServerView[];

const proj = (id: string, teamId: string, name: string, envs: Array<[string, string]>) =>
  ({ id, teamId, name, environments: envs.map(([eid, ename]) => ({ id: eid, name: ename })) }) as unknown as Project;

const PROJECTS = [
  proj("p1", "t1", "Shop", [["e1", "production"], ["e2", "staging"]]),
  proj("p2", "t2", "Other", [["e9", "secret"]]),
];

let qc: QueryClient;
function show(currentEnvironmentId: string | null = "e1") {
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <CloneAppModal appId="a1" defaultName="web (copy)" teamId="t1" currentServerId="s1" currentEnvironmentId={currentEnvironmentId} onClose={() => undefined} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("CloneAppModal", () => {
  let clone: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    pushMock.mockClear();
    vi.spyOn(api, "listServers").mockResolvedValue(SERVERS);
    vi.spyOn(api, "listProjects").mockResolvedValue(PROJECTS);
    clone = vi.spyOn(api, "cloneApp").mockResolvedValue({ app: { id: "a2" } as Application, warnings: [] });
  });

  it("offers only this team's environments and defaults to the source's own", async () => {
    show();
    const select = (await screen.findByLabelText("Environment")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("e1"));
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("Shop / production (current)");
    expect(labels).toContain("Shop / staging");
    expect(labels.some((l) => l?.includes("Other"))).toBe(false);
  });

  it("the default request carries no environmentId", async () => {
    show();
    await waitFor(() => expect((screen.getByLabelText("Environment") as HTMLSelectElement).value).toBe("e1"));
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    await waitFor(() => expect(clone).toHaveBeenCalled());
    expect(clone).toHaveBeenCalledWith("a1", { name: "web (copy)", serverId: "s1" });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/apps/a2"));
  });

  it("a changed environment is sent, alongside the server choice", async () => {
    show();
    await waitFor(() => expect((screen.getByLabelText("Environment") as HTMLSelectElement).value).toBe("e1"));
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "e2" } });
    await waitFor(() => expect((screen.getByLabelText("Server") as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.change(screen.getByLabelText("Server"), { target: { value: "s2" } });
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    await waitFor(() => expect(clone).toHaveBeenCalled());
    expect(clone).toHaveBeenCalledWith("a1", { name: "web (copy)", serverId: "s2", environmentId: "e2" });
  });

  it("falls back to a same-as-source placeholder when the current environment is not listed", async () => {
    show("gone");
    const select = (await screen.findByLabelText("Environment")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    expect(select.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    await waitFor(() => expect(clone).toHaveBeenCalled());
    expect(clone).toHaveBeenCalledWith("a1", { name: "web (copy)", serverId: "s1" });
  });

  it("shows the hub's error message", async () => {
    clone.mockRejectedValue(new Error("environment not found in this team"));
    show();
    await waitFor(() => expect((screen.getByLabelText("Environment") as HTMLSelectElement).value).toBe("e1"));
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "e2" } });
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    expect(await screen.findByText("environment not found in this team")).toBeTruthy();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
