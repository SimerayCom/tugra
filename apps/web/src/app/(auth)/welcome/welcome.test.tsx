import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../../i18n/provider";
import type { PublicUser } from "../../../lib/types";

// useAuth, router, and the ?step= / ?server= search params are all mutable per test.
const h = vi.hoisted(() => ({
  auth: { user: null as PublicUser | null, loading: false, initialized: null as boolean | null, reload: vi.fn() },
  search: "",
}));
const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => h.auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  useSearchParams: () => new URLSearchParams(h.search),
}));

import WelcomePage from "./page";
import { api } from "../../../lib/api";

const owner = { id: "u1", isInstanceOwner: true } as PublicUser;

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <WelcomePage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("WelcomePage wizard", () => {
  beforeEach(() => {
    nav.replace.mockClear();
    nav.push.mockClear();
    h.auth = { user: null, loading: false, initialized: null, reload: vi.fn() };
    h.search = "";
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the welcome intro on a fresh, logged-out install; Get started → ?step=create-admin", () => {
    h.auth = { user: null, loading: false, initialized: false, reload: vi.fn() };
    wrap();
    expect(screen.getByText("Welcome to Tugra")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(nav.replace).toHaveBeenCalledWith("/welcome?step=create-admin");
  });

  it("clamps a not-logged-in visitor OFF a post-bootstrap ?step back to create-admin", () => {
    h.auth = { user: null, loading: false, initialized: false, reload: vi.fn() };
    h.search = "step=add-first-server"; // trying to skip bootstrap
    wrap();
    expect(screen.getByText("Create the owner account")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  });

  it("create-admin: registers the owner then advances to instance-basics", async () => {
    h.auth = { user: null, loading: false, initialized: false, reload: vi.fn() };
    h.search = "step=create-admin";
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ initialized: false, allowRegistration: false, edition: "community", ssoEnabled: false, setupCodeRequired: false });
    const reg = vi.spyOn(api, "register").mockResolvedValue({} as PublicUser);
    wrap();
    expect(screen.queryByLabelText("Setup code")).toBeNull(); // not required → no field
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@x.co" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "supersecret1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account & continue" }));
    await waitFor(() => expect(reg).toHaveBeenCalledWith("owner@x.co", "supersecret1", undefined, undefined));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/welcome?step=instance-basics"));
    expect(h.auth.reload).toHaveBeenCalled();
  });

  it("create-admin: shows the Setup code field when required and passes the code to register", async () => {
    h.auth = { user: null, loading: false, initialized: false, reload: vi.fn() };
    h.search = "step=create-admin";
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ initialized: false, allowRegistration: false, edition: "community", ssoEnabled: false, setupCodeRequired: true });
    const reg = vi.spyOn(api, "register").mockResolvedValue({} as PublicUser);
    wrap();
    const codeField = await screen.findByLabelText("Setup code");
    fireEvent.change(codeField, { target: { value: "abcd1234" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@x.co" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "supersecret1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account & continue" }));
    await waitFor(() => expect(reg).toHaveBeenCalledWith("owner@x.co", "supersecret1", undefined, "abcd1234"));
  });

  it("redirects to /login once initialized and logged out", () => {
    h.auth = { user: null, loading: false, initialized: true, reload: vi.fn() };
    wrap();
    expect(nav.replace).toHaveBeenCalledWith("/login");
  });

  it("redirects a non-owner to the dashboard (no onboarding for them)", () => {
    h.auth = { user: { id: "u2", isInstanceOwner: false } as PublicUser, loading: false, initialized: true, reload: vi.fn() };
    wrap();
    expect(nav.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("a logged-in owner with no ?step resumes at instance-basics", () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ apiEnabled: true, apiAllowedIps: [], publicUrl: null, acmeEmail: null });
    wrap();
    expect(screen.getByText("Instance basics")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
  });

  it("instance-basics: Save is disabled until the current settings load (no clobber-before-prefill)", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=instance-basics";
    let resolveSettings!: (v: unknown) => void;
    vi.spyOn(api, "getInstanceSettings").mockReturnValue(new Promise((r) => (resolveSettings = r)) as never);
    wrap();
    const save = screen.getByRole("button", { name: "Save & continue" });
    expect(save).toBeDisabled(); // query still pending → cannot submit empty and wipe values
    resolveSettings({ apiEnabled: true, apiAllowedIps: [], publicUrl: "https://old", acmeEmail: null });
    await waitFor(() => expect(save).not.toBeDisabled());
  });

  it("instance-basics Skip jumps to done", () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ apiEnabled: true, apiAllowedIps: [], publicUrl: null, acmeEmail: null });
    h.search = "step=instance-basics";
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(nav.replace).toHaveBeenCalledWith("/welcome?step=done");
  });

  it("add-first-server: does NOT create on mount; creates only on click, then pins ?server=", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=add-first-server"; // no ?server → create form
    vi.spyOn(api, "listServers").mockResolvedValue([]); // no local box → manual add form
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "My Team", role: "OWNER" }] as never);
    const create = vi.spyOn(api, "createServer").mockResolvedValue({ server: { id: "srv1" }, enrollToken: "e", installCommand: "cmd" } as never);
    wrap();
    // the manual add form appears once the (empty) server list loads — and no server is created on mount
    const nameField = await screen.findByLabelText("Server name");
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(nameField, { target: { value: "prod-1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create server" })).not.toHaveProperty("disabled", true));
    fireEvent.click(screen.getByRole("button", { name: "Create server" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("prod-1", "t1"));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/welcome?step=add-first-server&server=srv1"));
  });

  it("add-first-server: auto-shows 'This machine' connecting (no manual add form) when a local server exists", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=add-first-server";
    vi.spyOn(api, "listServers").mockResolvedValue([{ id: "srv-local", name: "This machine", isLocal: true, status: "PENDING" }] as never);
    vi.spyOn(api, "getServerInstall").mockResolvedValue({ status: "PENDING", installCommand: null, expiresAt: null } as never);
    wrap();
    expect(await screen.findByText("Connecting this machine…")).toBeTruthy();
    expect(screen.queryByLabelText("Server name")).toBeNull(); // manual add form is skipped
  });

  it("done: a Home-mode owner finishes on the launcher (/home), a Fleet owner on /dashboard", () => {
    h.auth = { user: { id: "u1", isInstanceOwner: true, uiMode: "home" } as PublicUser, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=done";
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Go to your apps" })); // label matches the /home destination
    expect(nav.replace).toHaveBeenCalledWith("/home");

    cleanup();
    nav.replace.mockClear();
    h.auth = { user: { id: "u1", isInstanceOwner: true, uiMode: "fleet" } as PublicUser, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=done";
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Go to dashboard" }));
    expect(nav.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("shows a spinner (no redirect) while status is still unknown", () => {
    h.auth = { user: null, loading: false, initialized: null, reload: vi.fn() };
    wrap();
    expect(screen.queryByText("Welcome to Tugra")).toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
