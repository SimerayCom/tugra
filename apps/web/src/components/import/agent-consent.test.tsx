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

const view = (over: Record<string, unknown> = {}) => ({ id: "g1", kind: "secrets", serverId: "s0", classes: ["env"], status: "active", grantedById: "u1", expiresAt: "2026-11-27T10:00:00Z", revokedAt: null, createdAt: "2026-11-26T10:00:00Z", ...over });

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
  it("shows what may be read with the counts the read found; tier 1 is ticked and tier 2 is not", () => {
    mount();
    expect(screen.getByText("Allow reading secret values")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Environment variables/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("1240 found")).toBeTruthy();
    for (const t2 of [/Notification tokens/, /Git app private keys/, /Deploy keys/]) expect((screen.getByRole("checkbox", { name: t2 }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByText("Off by default").length).toBe(3);
    expect(screen.getByText(/Never read: the Coolify encryption key/)).toBeTruthy();
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

  it("asks the hub for THIS import session, with the ticked classes, the hours and the typed name, then shows it as allowed", async () => {
    const grant = vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue(view({ classes: ["env", "shared_env"] }) as never);
    const changed = vi.fn();
    mount({ onChanged: changed });
    fireEvent.click(screen.getByRole("checkbox", { name: /Deploy keys/ })); // tier 2 opt-in
    fireEvent.change(screen.getByLabelText("Allow for (hours)"), { target: { value: "4" } });
    typeName("coolify-host");
    fireEvent.click(allowBtn());
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(1));
    const body = grant.mock.calls[0][0];
    expect(body).toMatchObject({ serverId: "s0", confirm: "coolify-host", importSessionId: "sess-1", hours: 4 });
    expect(body.classes).toEqual(expect.arrayContaining(["env", "deploy_key"]));
    expect(body.classes).not.toContain("notification");
    await screen.findByText("Secret values are allowed for this import");
    expect(screen.getByText("Allowed")).toBeTruthy();
    expect(screen.getByText(/This consent ends when the import is finished or you stop it/)).toBeTruthy();
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
