import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api, ApiError } from "../../lib/api";
import { ToastProvider } from "../toast";
import { AgentConsentCard } from "./agent-consent";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const view = (over: Record<string, unknown> = {}) => ({ id: "g1", kind: "secrets", serverId: "s0", classes: ["env"], status: "active", grantedById: "u1", expiresAt: "2999-11-27T10:00:00Z", revokedAt: null, createdAt: "2026-11-26T10:00:00Z", ...over });

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
const mount = (props: Partial<React.ComponentProps<typeof AgentConsentCard>> = {}) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <AgentConsentCard serverId="s0" serverName="coolify-host" teamId="t1" sessionId="sess-1" secretCounts={{ env: 1240, db_credentials: 29, s3: 2 }} {...props} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const typeName = (v: string) => fireEvent.change(screen.getByLabelText("Type the Coolify server name to allow it"), { target: { value: v } });
const allowBtn = () => screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement;

describe("AgentConsentCard", () => {
  it("shows what may be read with the counts the read found; the classes the import reads are ticked, notification tokens are not", () => {
    mount();
    expect(screen.getByText("Allow reading secret values")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Environment variables/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("1240 found")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Notification tokens/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByText("Off by default").length).toBe(1);
    expect(screen.getByText(/Never read: the Coolify encryption key/)).toBeTruthy();
  });

  it("offers only what the import reads: a class with no reader is listed as not used yet, unticked and cannot be ticked (no promise of S3 keys or deploy keys)", () => {
    mount({ secretCounts: { env: 1, s3: 2, basic_auth: 3 } });
    for (const c of [/Basic-auth passwords/, /S3 storage keys/, /Git app private keys/, /Deploy keys/]) {
      const box = screen.getByRole("checkbox", { name: c }) as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(box.disabled).toBe(true);
    }
    expect(screen.getAllByText("Not read by the import yet").length).toBe(4);
    for (const c of [/Environment variables/, /Shared variables/, /Database credentials/, /Compose files/, /Scheduled task commands/]) expect((screen.getByRole("checkbox", { name: c }) as HTMLInputElement).checked).toBe(true);
  });

  it("says what will be missing when a class the apply needs is unticked, and says nothing while all of them are on", () => {
    mount();
    expect(screen.queryByTestId("consent-missing")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Environment variables/ }));
    expect(screen.getByTestId("consent-missing").textContent).toMatch(/Without Environment variables, apps and databases are created without those values/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Database credentials/ }));
    expect(screen.getByTestId("consent-missing").textContent).toMatch(/Environment variables, Database credentials/);
  });

  it("allows nothing until the server name is typed exactly", () => {
    mount();
    expect(allowBtn().disabled).toBe(true);
    for (const v of ["coolify", "Coolify-host", "coolify-host "]) {
      typeName(v);
      expect(allowBtn().disabled).toBe(true);
    }
    typeName("coolify-host");
    expect(allowBtn().disabled).toBe(false);
    // and not with every class un-ticked
    for (const c of screen.getAllByRole("checkbox")) if ((c as HTMLInputElement).checked) fireEvent.click(c);
    expect(allowBtn().disabled).toBe(true);
  });

  it("asks the hub for THIS import session, with the ticked classes and the typed name (no window of its own: it ends with the session), then shows it as allowed", async () => {
    const grant = vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue(view({ classes: ["env", "shared_env"] }) as never);
    const changed = vi.fn();
    mount({ onChanged: changed });
    fireEvent.click(screen.getByRole("checkbox", { name: /Notification tokens/ })); // tier 2 opt-in
    expect(screen.queryByLabelText("Allow for (hours)")).toBeNull();
    typeName("coolify-host");
    fireEvent.click(allowBtn());
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(1));
    const body = grant.mock.calls[0][0];
    expect(body).toMatchObject({ serverId: "s0", confirm: "coolify-host", importSessionId: "sess-1" });
    expect(body).not.toHaveProperty("hours");
    expect(body.classes).toEqual(expect.arrayContaining(["env", "notification"]));
    for (const unread of ["basic_auth", "s3", "git_app_key", "deploy_key"]) expect(body.classes).not.toContain(unread);
    await screen.findByText("Secret values are allowed for this import");
    expect(screen.getByText("Allowed")).toBeTruthy();
    expect(screen.getByText(/This permission ends when the import is finished, when this connection ends/)).toBeTruthy();
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    // the typed name is not kept around
    expect(screen.queryByLabelText("Type the Coolify server name to allow it")).toBeNull();
  });

  it("stops the consent with one click", async () => {
    vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue(view() as never);
    const revoke = vi.spyOn(api, "coolifySecretsRevoke").mockResolvedValue(view({ status: "revoked" }) as never);
    mount();
    typeName("coolify-host");
    fireEvent.click(allowBtn());
    fireEvent.click(await screen.findByRole("button", { name: "Stop allowing" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("g1"));
    await screen.findByText("Allow reading secret values");
  });

  it("finds a standing consent after a reload (the plan says it stands) and can stop it", async () => {
    const list = vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([view({ id: "gx", serverId: "other", status: "active" }), view({ id: "g9" }), view({ id: "old", status: "expired" })] as never);
    const revoke = vi.spyOn(api, "coolifySecretsRevoke").mockResolvedValue(view({ status: "revoked" }) as never);
    mount({ standing: ["env", "s3"] });
    await screen.findByText("Secret values are allowed for this import");
    expect(screen.getByText(/Environment variables, S3 storage keys/)).toBeTruthy();
    expect(list).toHaveBeenCalledWith("t1");
    fireEvent.click(await screen.findByRole("button", { name: "Stop allowing" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("g9"));
  });

  it("a member who is not an owner gets the reason, not a silent failure", async () => {
    vi.spyOn(api, "coolifySecretsGrant").mockRejectedValue(new ApiError(403, "insufficient role for this team"));
    mount();
    typeName("coolify-host");
    fireEvent.click(allowBtn());
    await screen.findByText("Only an owner of the team can allow this.");
    expect(screen.getByText("Allow reading secret values")).toBeTruthy(); // still asking
  });

  it("says why when the agent is offline, too old, or another consent is active", async () => {
    const grant = vi.spyOn(api, "coolifySecretsGrant");
    mount();
    typeName("coolify-host");
    grant.mockRejectedValueOnce(new ApiError(409, "x", "agent_offline"));
    fireEvent.click(allowBtn());
    await screen.findByText(/The agent on the Coolify server is offline/);
    grant.mockRejectedValueOnce(new ApiError(409, "x", "agent_too_old"));
    fireEvent.click(allowBtn());
    await screen.findByText(/too old for this/);
    grant.mockRejectedValueOnce(new ApiError(409, "x", "grant_active"));
    fireEvent.click(allowBtn());
    await screen.findByText(/Another consent with different choices is active/);
  });

  describe("what the card shows is the hub's state, not its own memory", () => {
    const allowNow = async () => {
      vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue(view() as never);
      mount();
      typeName("coolify-host");
      fireEvent.click(allowBtn());
      await screen.findByText("Secret values are allowed for this import");
    };

    it("goes back to asking, with the reason, when the grant it made was replaced by another owner's consent for the same host", async () => {
      const list = vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([view({ status: "active", expiresAt: "2999-01-01T00:00:00Z" })] as never);
      const changed = vi.fn();
      vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue(view({ expiresAt: "2999-01-01T00:00:00Z" }) as never);
      mount({ onChanged: changed });
      typeName("coolify-host");
      fireEvent.click(allowBtn());
      await screen.findByText("Secret values are allowed for this import");
      expect(screen.queryByTestId("consent-ended")).toBeNull();
      // the hub now lists it as ended (revoked by the other owner's consent), and the card asks the hub again when the window is focused
      list.mockResolvedValue([view({ status: "revoked", expiresAt: "2999-01-01T00:00:00Z" })] as never);
      await qc.invalidateQueries({ queryKey: ["coolify-secret-grants", "t1"] });
      await screen.findByTestId("consent-ended");
      expect(screen.getByText("Allow reading secret values")).toBeTruthy();
      expect(changed).toHaveBeenLastCalledWith(null);
    });

    it("does not call a lapsed window allowed", async () => {
      vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([] as never);
      vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue(view({ expiresAt: "2020-01-01T00:00:00Z" }) as never);
      mount();
      typeName("coolify-host");
      fireEvent.click(allowBtn());
      await screen.findByTestId("consent-ended");
      expect(screen.queryByText("Secret values are allowed for this import")).toBeNull();
    });

    it("a new session id is a new card (the old consent is not carried over to it)", async () => {
      await allowNow();
      cleanup();
      mount({ sessionId: "sess-2" });
      expect(screen.getByText("Allow reading secret values")).toBeTruthy();
    });
  });

  it("tells a team member who is not an owner so up front, with no form to fill in for nothing", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "ADMIN" }] as never);
    mount();
    await screen.findByTestId("consent-owner-only");
    expect(screen.getByText(/Only an owner of the team can allow this\. Ask an owner of Acme to run this move/)).toBeTruthy();
    expect(screen.queryByLabelText("Type the Coolify server name to allow it")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("offers 'Not now' only when the parent handles it", () => {
    const skip = vi.fn();
    mount({ onSkip: skip });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(skip).toHaveBeenCalled();
    cleanup();
    mount();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });
});
