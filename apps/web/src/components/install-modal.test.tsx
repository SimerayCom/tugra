import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { InstallModal } from "./install-modal";
import { api } from "../lib/api";
import type { Template, TemplateManifest, ServerView } from "../lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

const TEMPLATE: Template = { slug: "ghost", name: "Ghost", description: "Publishing platform", category: "cms" };

const SERVERS = [{ id: "s1", name: "prod", status: "ONLINE" }] as unknown as ServerView[];

const MANIFEST: TemplateManifest = {
  ...TEMPLATE,
  fields: [
    { key: "pw", type: "password", label: "Password", required: true },
    { key: "port", type: "number", label: "Port", min: 1, max: 65535 },
  ],
  composeFile: "services:\n  web:\n    image: ghost\n",
};

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("InstallModal", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(api, "listServers").mockResolvedValue(SERVERS);
    vi.spyOn(api, "getTemplateManifest").mockResolvedValue(MANIFEST);
  });
  afterEach(() => vi.restoreAllMocks());

  it("fetches the manifest and renders its typed fields", async () => {
    wrap(<InstallModal template={TEMPLATE} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Password *")).toBeTruthy());
    expect(screen.getByLabelText("Port")).toBeTruthy();
    expect(api.getTemplateManifest).toHaveBeenCalledWith("ghost", expect.anything());
  });

  it("disables Install while a required field is blank, enables it once filled", async () => {
    wrap(<InstallModal template={TEMPLATE} onClose={vi.fn()} />);
    // The button renders immediately, but the required field appears only once the manifest loads.
    const pw = await screen.findByLabelText("Password *");
    expect((screen.getByText("Install") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(pw, { target: { value: "hunter2" } });
    await waitFor(() => expect((screen.getByText("Install") as HTMLButtonElement).disabled).toBe(false));
  });

  it("submits createFromTemplate with only the non-empty fields", async () => {
    const spy = vi.spyOn(api, "createFromTemplate").mockResolvedValue({ id: "app1" } as never);
    wrap(<InstallModal template={TEMPLATE} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Password *")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Password *"), { target: { value: "hunter2" } });
    fireEvent.click(await screen.findByText("Install"));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("ghost", {
        name: "Ghost",
        serverId: "s1",
        deploy: true,
        fields: { pw: "hunter2" },
      }),
    );
  });

  it("shows the server error message when the install fails", async () => {
    vi.spyOn(api, "createFromTemplate").mockRejectedValue(new Error("Port 8080 already in use"));
    wrap(<InstallModal template={TEMPLATE} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Password *")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Password *"), { target: { value: "hunter2" } });
    fireEvent.click(await screen.findByText("Install"));
    await waitFor(() => expect(screen.getByText("Port 8080 already in use")).toBeTruthy());
  });

  it("seeds field defaults into the form and includes them on submit", async () => {
    const withDefaults: TemplateManifest = {
      ...TEMPLATE,
      fields: [
        { key: "tz", type: "text", label: "Timezone", default: "UTC" },
        { key: "tls", type: "boolean", label: "Enable TLS", default: "true" },
      ],
    };
    vi.spyOn(api, "getTemplateManifest").mockResolvedValue(withDefaults);
    const spy = vi.spyOn(api, "createFromTemplate").mockResolvedValue({ id: "app1" } as never);
    wrap(<InstallModal template={TEMPLATE} onClose={vi.fn()} />);
    const tz = (await screen.findByLabelText("Timezone")) as HTMLInputElement;
    expect(tz.value).toBe("UTC");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(await screen.findByText("Install"));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("ghost", {
        name: "Ghost",
        serverId: "s1",
        deploy: true,
        fields: { tz: "UTC", tls: "true" },
      }),
    );
  });

  it("surfaces a manifest load error yet still allows installing with defaults", async () => {
    vi.spyOn(api, "getTemplateManifest").mockRejectedValue(new Error("boom"));
    wrap(<InstallModal template={TEMPLATE} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Couldn't load this template/)).toBeTruthy());
    // No required fields could be resolved, so install stays available (the server generates defaults).
    expect((screen.getByText("Install") as HTMLButtonElement).disabled).toBe(false);
  });

  it("reveals the advanced compose/env override behind a toggle", async () => {
    wrap(<InstallModal template={TEMPLATE} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Password *")).toBeTruthy());
    // collapsed by default
    expect(screen.queryByText("Compose file")).toBeNull();
    fireEvent.click(screen.getByText(/Advanced: edit compose \/ env/)); // button has a ▸ arrow prefix
    expect(screen.getByText("Compose file")).toBeTruthy();
    expect(screen.getByText("Environment overrides")).toBeTruthy();
  });

  // ── live install progress ──

  it("after install, shows the live progress and a ready state with an Open link when the app is RUNNING", async () => {
    vi.spyOn(api, "createFromTemplate").mockResolvedValue({ id: "app1", status: "RUNNING", url: "https://ghost.example.com" } as never);
    vi.spyOn(api, "getApp").mockResolvedValue({ id: "app1", status: "RUNNING", url: "https://ghost.example.com" } as never);
    wrap(<InstallModal template={TEMPLATE} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Password *"), { target: { value: "hunter2" } });
    fireEvent.click(await screen.findByText("Install"));
    expect(await screen.findByText(/is ready/)).toBeTruthy();
    const open = screen.getByRole("link", { name: /Open/ });
    expect(open.getAttribute("href")).toBe("https://ghost.example.com");
  });

  it("after a FAILED install shows a Retry (and fetches a log tail)", async () => {
    vi.spyOn(api, "createFromTemplate").mockResolvedValue({ id: "app1", status: "FAILED", url: null } as never);
    vi.spyOn(api, "getApp").mockResolvedValue({ id: "app1", status: "FAILED", url: null } as never);
    const logs = vi.spyOn(api, "getAppLogs").mockResolvedValue({ output: "boom: port in use" });
    wrap(<InstallModal template={TEMPLATE} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Password *"), { target: { value: "hunter2" } });
    fireEvent.click(await screen.findByText("Install"));
    expect(await screen.findByText(/failed to install/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    await waitFor(() => expect(logs).toHaveBeenCalledWith("app1", 40));
  });
});
