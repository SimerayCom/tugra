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

  it("create-admin: registers the owner then advances to choose-mode", async () => {
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
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/welcome?step=choose-mode"));
    expect(h.auth.reload).toHaveBeenCalled();
  });

  it("choose-mode: picking Home persists uiMode and advances to instance-basics", async () => {
    h.auth = { user: { ...owner, uiMode: "fleet" } as PublicUser, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=choose-mode";
    const upd = vi.spyOn(api, "updateProfile").mockResolvedValue({ ...owner, uiMode: "home" } as PublicUser);
    wrap();
    expect(screen.getByText("How will you use Tugra?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Home — simple launcher/ }));
    await waitFor(() => expect(upd).toHaveBeenCalledWith({ uiMode: "home" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/welcome?step=instance-basics"));
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

  it("a logged-in owner with no ?step resumes at choose-mode (the new first post-bootstrap step)", () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    wrap();
    expect(screen.getByText("How will you use Tugra?")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull(); // choose-mode is an uncounted interstitial
  });

  const team = { id: "t1", name: "My Team", role: "OWNER" };
  const emptySettings = { apiEnabled: true, apiAllowedIps: [], publicUrl: null, acmeEmail: null };

  it("instance-basics: Save is disabled until the current settings load (no clobber-before-prefill)", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=instance-basics";
    let resolveSettings!: (v: unknown) => void;
    vi.spyOn(api, "getInstanceSettings").mockReturnValue(new Promise((r) => (resolveSettings = r)) as never);
    vi.spyOn(api, "listTeams").mockResolvedValue([team] as never);
    wrap();
    const save = screen.getByRole("button", { name: "Save & continue" });
    expect(save).toBeDisabled(); // query still pending → cannot submit empty and wipe values
    resolveSettings({ ...emptySettings, publicUrl: "https://old" });
    await waitFor(() => expect(save).not.toBeDisabled());
  });

  it("instance-basics: pre-fills the Public URL and Let's Encrypt email from the install when nothing is saved yet", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=instance-basics";
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ ...emptySettings, suggested: { publicUrl: "https://hub.acme.test", acmeEmail: "ops@acme.test" } });
    vi.spyOn(api, "listTeams").mockResolvedValue([team] as never);
    wrap();
    await waitFor(() => expect((screen.getByLabelText("Public URL") as HTMLInputElement).value).toBe("https://hub.acme.test"));
    expect((screen.getByLabelText("Let's Encrypt email") as HTMLInputElement).value).toBe("ops@acme.test");
  });

  it("instance-basics: a value the owner already saved wins over the install's suggestion", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=instance-basics";
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ ...emptySettings, publicUrl: "https://saved.acme.test", suggested: { publicUrl: "https://hub.acme.test", acmeEmail: null } });
    vi.spyOn(api, "listTeams").mockResolvedValue([team] as never);
    wrap();
    await waitFor(() => expect((screen.getByLabelText("Public URL") as HTMLInputElement).value).toBe("https://saved.acme.test"));
  });

  it("instance-basics: asks for the team name (empty for the default 'My Team'), renames the team and saves the basics", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=instance-basics";
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ ...emptySettings, suggested: { publicUrl: "https://hub.acme.test", acmeEmail: "ops@acme.test" } });
    vi.spyOn(api, "listTeams").mockResolvedValue([team] as never);
    const rename = vi.spyOn(api, "renameTeam").mockResolvedValue(undefined as never);
    const upd = vi.spyOn(api, "updateInstanceSettings").mockResolvedValue({} as never);
    wrap();
    const name = (await screen.findByLabelText("Team or company name")) as HTMLInputElement;
    expect(name.value).toBe(""); // never "<Name>'s Team" / the placeholder
    await waitFor(() => expect((screen.getByLabelText("Public URL") as HTMLInputElement).value).toBe("https://hub.acme.test"));
    fireEvent.change(name, { target: { value: "Acme Inc." } });
    fireEvent.click(screen.getByRole("button", { name: "Save & continue" }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith("t1", "Acme Inc."));
    await waitFor(() => expect(upd).toHaveBeenCalledWith({ publicUrl: "https://hub.acme.test", acmeEmail: "ops@acme.test" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/welcome?step=email"));
  });

  it("'Skip this step' moves to the NEXT step (not the end), and 'Finish setup later' leaves the wizard", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue(emptySettings);
    vi.spyOn(api, "listTeams").mockResolvedValue([team] as never);
    h.search = "step=instance-basics";
    wrap();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip setup" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    expect(nav.replace).toHaveBeenCalledWith("/welcome?step=email");
    fireEvent.click(screen.getByRole("button", { name: "Finish setup later" }));
    expect(nav.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("Back returns to the previous step (so the Fleet/Home pick can be changed) and is absent where it can't go back", () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue(emptySettings);
    vi.spyOn(api, "listTeams").mockResolvedValue([team] as never);
    h.search = "step=instance-basics";
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(nav.replace).toHaveBeenCalledWith("/welcome?step=choose-mode");
    cleanup();
    h.search = "step=choose-mode"; // right after the account exists: nothing to go back to
    wrap();
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });

  it("email: saves Resend (key + From) and moves on; Skip leaves email off", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=email";
    vi.spyOn(api, "getMailSettings").mockResolvedValue({ provider: "none", host: null, port: null, secure: false, user: null, from: null, hasPassword: false, hasResendKey: false, effective: "none" });
    const upd = vi.spyOn(api, "updateMailSettings").mockResolvedValue({} as never);
    wrap();
    const save = screen.getByRole("button", { name: "Save & continue" });
    expect(save).toBeDisabled(); // needs a key and a From
    fireEvent.change(screen.getByLabelText("Resend API key"), { target: { value: "re_123" } });
    fireEvent.change(screen.getByLabelText("From address"), { target: { value: "Acme <no-reply@acme.test>" } });
    fireEvent.click(save);
    await waitFor(() => expect(upd).toHaveBeenCalledWith({ provider: "resend", from: "Acme <no-reply@acme.test>", resendKey: "re_123" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/welcome?step=security"));
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    expect(nav.replace).toHaveBeenLastCalledWith("/welcome?step=security");
    expect(upd).toHaveBeenCalledTimes(1);
  });

  it("security: offers 2FA setup (skippable); once on, offers the 'require for owners and admins' policy", async () => {
    h.auth = { user: { ...owner, twoFaEnabled: false } as PublicUser, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=security";
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ ...emptySettings, require2fa: false });
    const setup = vi.spyOn(api, "setup2fa").mockResolvedValue({ otpauthUrl: "otpauth://x", qrDataUrl: "data:image/png;base64,AAAA" });
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    expect(nav.replace).toHaveBeenCalledWith("/welcome?step=add-first-server");
    fireEvent.click(screen.getByRole("button", { name: "Set up 2FA" }));
    await waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("2FA or recovery code")).toBeTruthy();

    cleanup();
    h.auth = { user: { ...owner, twoFaEnabled: true } as PublicUser, loading: false, initialized: true, reload: vi.fn() };
    const upd = vi.spyOn(api, "updateInstanceSettings").mockResolvedValue({} as never);
    wrap();
    const box = (await screen.findByLabelText("Require 2FA for owners and admins")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(upd).toHaveBeenCalledWith({ require2fa: true }));
  });

  it("summary: lists every section with an Edit link; editing returns to the summary; Finish goes to done", async () => {
    h.auth = { user: { ...owner, uiMode: "fleet", twoFaEnabled: true } as PublicUser, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=summary";
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ ...emptySettings, publicUrl: "https://hub.acme.test", acmeEmail: "ops@acme.test", require2fa: true });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme Inc.", role: "OWNER" }] as never);
    vi.spyOn(api, "getMailSettings").mockResolvedValue({ provider: "resend", host: null, port: null, secure: false, user: null, from: "a@acme.test", hasPassword: false, hasResendKey: true, effective: "db" });
    vi.spyOn(api, "listServers").mockResolvedValue([{ id: "s1", name: "This machine", isLocal: true, status: "ONLINE" }] as never);
    wrap();
    expect(await screen.findByText("Acme Inc.")).toBeTruthy();
    expect(screen.getByText("https://hub.acme.test")).toBeTruthy();
    expect(screen.getByText("ops@acme.test")).toBeTruthy();
    expect(screen.getByText("Resend")).toBeTruthy();
    expect(screen.getByText("On, required for owners and admins")).toBeTruthy();
    expect(screen.getByText("This machine (connected)")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("7");
    fireEvent.click(screen.getByRole("button", { name: "Edit Team" }));
    expect(nav.replace).toHaveBeenCalledWith("/welcome?step=instance-basics&from=summary");
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(nav.replace).toHaveBeenCalledWith("/welcome?step=done");
  });

  it("editing from the summary: Save, Skip and Back all return to the summary", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=instance-basics&from=summary";
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue(emptySettings);
    vi.spyOn(api, "listTeams").mockResolvedValue([team] as never);
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "← Back to summary" }));
    expect(nav.replace).toHaveBeenLastCalledWith("/welcome?step=summary");
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    expect(nav.replace).toHaveBeenLastCalledWith("/welcome?step=summary");
  });

  it("add-first-server: does NOT create on mount; creates only on click, then pins ?server=", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=add-first-server"; // no ?server → create form
    vi.spyOn(api, "listServers").mockResolvedValue([]); // no local box → manual add form
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "My Team", role: "OWNER" }] as never);
    const create = vi.spyOn(api, "createServer").mockResolvedValue({ server: { id: "srv1" }, enrollToken: "e", installCommand: "cmd" } as never);
    wrap();
    // the manual add form appears once the (empty) server list loads — and no server is created on mount
    const nameField = await screen.findByLabelText("Server name (optional)");
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(nameField, { target: { value: "prod-1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create server" })).not.toHaveProperty("disabled", true));
    fireEvent.click(screen.getByRole("button", { name: "Create server" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("prod-1", "t1"));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/welcome?step=add-first-server&server=srv1"));
  });

  it("add-first-server: the name is optional - blank creates the server and the hint says the hostname is used", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=add-first-server";
    vi.spyOn(api, "listServers").mockResolvedValue([]);
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "My Team", role: "OWNER" }] as never);
    const create = vi.spyOn(api, "createServer").mockResolvedValue({ server: { id: "srv1" }, enrollToken: "e", installCommand: "cmd" } as never);
    wrap();
    const nameField = await screen.findByLabelText("Server name (optional)");
    expect((nameField as HTMLInputElement).required).toBe(false);
    expect(screen.getByText(/server's own hostname is used/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create server" })).not.toHaveProperty("disabled", true));
    fireEvent.click(screen.getByRole("button", { name: "Create server" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("", "t1"));
  });

  it("add-first-server: auto-shows 'This machine' connecting (no manual add form) when a local server exists", async () => {
    h.auth = { user: owner, loading: false, initialized: true, reload: vi.fn() };
    h.search = "step=add-first-server";
    vi.spyOn(api, "listServers").mockResolvedValue([{ id: "srv-local", name: "This machine", isLocal: true, status: "PENDING" }] as never);
    vi.spyOn(api, "getServerInstall").mockResolvedValue({ status: "PENDING", installCommand: null, expiresAt: null } as never);
    wrap();
    expect(await screen.findByText("Connecting this machine…")).toBeTruthy();
    expect(screen.queryByLabelText("Server name (optional)")).toBeNull(); // manual add form is skipped
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
