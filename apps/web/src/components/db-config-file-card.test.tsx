import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { DbConfigFileCard } from "./db-config-file-card";
import { api } from "../lib/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.restoreAllMocks();
});

const card = (over: Partial<React.ComponentProps<typeof DbConfigFileCard>> = {}) => {
  const onRedeploy = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <DbConfigFileCard id="d1" name="main-db" engine="POSTGRES" status="RUNNING" supported redeploying={false} onRedeploy={onRedeploy} {...over} />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onRedeploy };
};

describe("DbConfigFileCard", () => {
  it("loads the stored text and shows the engine's mount path", async () => {
    vi.spyOn(api, "getDatabaseConfigFile").mockResolvedValue({ supported: true, content: "max_connections = 50\n" });
    card();
    const field = (await screen.findByLabelText("Configuration file contents")) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("max_connections = 50\n"));
    expect(screen.getByText("Mounted at /etc/postgresql/postgresql.conf")).toBeTruthy();
  });

  it("renders nothing for an engine without a config file and never fetches", () => {
    const get = vi.spyOn(api, "getDatabaseConfigFile");
    card({ supported: false, engine: "CLICKHOUSE" });
    expect(screen.queryByText("Configuration file")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("Save stays off until the text changes, then saves it and offers a redeploy", async () => {
    vi.spyOn(api, "getDatabaseConfigFile").mockResolvedValue({ supported: true, content: "a=1\n" });
    const set = vi.spyOn(api, "setDatabaseConfigFile").mockResolvedValue({ restartRequired: true });
    card();
    const field = (await screen.findByLabelText("Configuration file contents")) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("a=1\n"));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "a=2\n" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(set).toHaveBeenCalledWith("d1", "a=2\n"));
    expect(await screen.findByText("Saved. Redeploy to apply it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Redeploy" })).toBeTruthy();
  });

  it("a blank text clears the file (null) and redeploy asks for confirmation first", async () => {
    vi.spyOn(api, "getDatabaseConfigFile").mockResolvedValue({ supported: true, content: "a=1\n" });
    const set = vi.spyOn(api, "setDatabaseConfigFile").mockResolvedValue({ restartRequired: true });
    const { onRedeploy } = card();
    const field = (await screen.findByLabelText("Configuration file contents")) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("a=1\n"));
    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("d1", null));
    fireEvent.click(await screen.findByRole("button", { name: "Redeploy" }));
    expect(onRedeploy).not.toHaveBeenCalled();
    expect(await screen.findByText("Redeploy main-db?")).toBeTruthy();
    const confirmBtns = screen.getAllByRole("button", { name: "Redeploy" });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);
    await waitFor(() => expect(onRedeploy).toHaveBeenCalledTimes(1));
  });

  it("a never-deployed database says it applies on the first deploy and offers no redeploy", async () => {
    vi.spyOn(api, "getDatabaseConfigFile").mockResolvedValue({ supported: true, content: null });
    vi.spyOn(api, "setDatabaseConfigFile").mockResolvedValue({ restartRequired: false });
    card({ status: "NEW", engine: "MONGO" });
    const field = (await screen.findByLabelText("Configuration file contents")) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "net:\n  port: 27017\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. It applies on the first deploy.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Redeploy" })).toBeNull();
  });

  it("an oversized text cannot be saved", async () => {
    vi.spyOn(api, "getDatabaseConfigFile").mockResolvedValue({ supported: true, content: "" });
    card();
    const field = (await screen.findByLabelText("Configuration file contents")) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "x".repeat(64 * 1024 + 1) } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Too large. The limit is 64 KiB.")).toBeTruthy();
  });
});
