import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { CoolifyHostGrantView } from "@tugra/shared";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError } from "../lib/api";
import { CoolifySecretsConsent, consentErrorText, defaultClasses } from "./coolify-secrets-consent";

afterEach(cleanup);
const grant = (o: Partial<CoolifyHostGrantView> = {}): CoolifyHostGrantView => ({ id: "g1", kind: "secrets", serverId: "s1", classes: ["env"], status: "active", grantedById: "u1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), revokedAt: null, createdAt: "2026-11-26T00:00:00Z", ...o });

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.restoreAllMocks();
});
const show = (props: Partial<React.ComponentProps<typeof CoolifySecretsConsent>> = {}) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <CoolifySecretsConsent teamId="t1" serverId="s1" serverName="coolify-hub" isOwner {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("CoolifySecretsConsent", () => {
  it("opens with the tier-1 classes ticked and the tier-2 ones off, and says what is never read", async () => {
    vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([]);
    show();
    await screen.findByTestId("secrets-consent");
    expect((screen.getByLabelText("Environment variables") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Notification tokens") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Deploy keys") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Never read: the Coolify encryption key/)).toBeTruthy();
    expect(defaultClasses()).not.toContain("deploy_key");
  });

  it("allows only after the host's name is typed, and sends exactly what was chosen", async () => {
    vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([]);
    const post = vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue(grant());
    show();
    const allow = await screen.findByRole("button", { name: "Allow" });
    expect((allow as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByLabelText("Type coolify-hub to allow");
    fireEvent.change(input, { target: { value: "coolify-hu" } });
    expect((allow as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "coolify-hub" } });
    fireEvent.click(screen.getByLabelText("Notification tokens"));
    fireEvent.click(allow);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0][0];
    expect(body).toMatchObject({ serverId: "s1", confirm: "coolify-hub", hours: 24 });
    expect(body.classes).toContain("notification");
    expect(body.classes).toContain("env");
    expect(body.classes).not.toContain("deploy_key");
  });

  it("will not allow with nothing ticked, and sends the hours that were typed", async () => {
    vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([]);
    const post = vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue(grant());
    show();
    const allow = await screen.findByRole("button", { name: "Allow" });
    fireEvent.change(screen.getByLabelText("Type coolify-hub to allow"), { target: { value: "coolify-hub" } });
    for (const c of defaultClasses()) {
      const label = { env: "Environment variables", shared_env: "Shared variables", db_credentials: "Database credentials", basic_auth: "Basic-auth passwords", service_compose: "Service definitions", task_command: "Scheduled task commands", s3: "S3 storage keys" }[c as string] as string;
      fireEvent.click(screen.getByLabelText(label));
    }
    expect((allow as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Environment variables"));
    fireEvent.change(screen.getByLabelText("Allowed for (hours)"), { target: { value: "48" } });
    fireEvent.click(allow);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0].hours).toBe(48);
  });

  it("shows an active consent with its end and lets the owner stop it", async () => {
    vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([grant()]);
    const revoke = vi.spyOn(api, "coolifySecretsRevoke").mockResolvedValue(grant({ status: "revoked" }));
    show();
    expect((await screen.findByRole("status")).textContent).toMatch(/^Allowed until /);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop allowing" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("g1"));
  });

  it("ignores an expired, a revoked and another server's consent", async () => {
    vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([grant({ status: "expired", expiresAt: new Date(Date.now() - 1000).toISOString() }), grant({ id: "g2", status: "revoked" }), grant({ id: "g3", serverId: "other" }), grant({ id: "g4", kind: "ssh" })]);
    show();
    await screen.findByRole("button", { name: "Allow" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("an admin sees the consent state but no form and no stop button", async () => {
    vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([grant()]);
    show({ isOwner: false });
    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: "Stop allowing" })).toBeNull();
    cleanup();
    vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([]);
    show({ isOwner: false });
    await screen.findByTestId("secrets-consent");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("a refused call shows a plain line, never the response text", async () => {
    vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([]);
    vi.spyOn(api, "coolifySecretsGrant").mockRejectedValue(new ApiError(409, "SECRET-RESPONSE-TEXT", "agent_offline"));
    show();
    await screen.findByRole("button", { name: "Allow" });
    fireEvent.change(screen.getByLabelText("Type coolify-hub to allow"), { target: { value: "coolify-hub" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The agent on the Coolify server is offline.");
    expect(document.body.textContent).not.toContain("SECRET-RESPONSE-TEXT");
  });
});

describe("consentErrorText", () => {
  const t = (k: string) => ({ "coolifyMove.consent.error.forbidden": "F", "coolifyMove.consent.error.name": "N", "coolifyMove.consent.error.generic": "G", "coolifyMove.consent.error.grant_active": "A" })[k] ?? k;
  it("maps known failures and falls back to a generic line", () => {
    expect(consentErrorText(t, new ApiError(403, "x"))).toBe("F");
    expect(consentErrorText(t, new ApiError(400, "x"))).toBe("N");
    expect(consentErrorText(t, new ApiError(409, "x", "grant_active"))).toBe("A");
    expect(consentErrorText(t, new ApiError(409, "x", "unheard_of"))).toBe("G");
    expect(consentErrorText(t, new Error("net"))).toBe("G");
  });
});
