import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ToastProvider } from "../../../components/toast";
import { api } from "../../../lib/api";
import type { MailSettings, PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false, email: "owner@x.io" } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { EmailSettingsCard } from "./email-settings-card";

const NONE: MailSettings = { provider: "none", host: null, port: null, secure: false, user: null, from: null, hasPassword: false, hasResendKey: false, effective: "none" };
const SMTP: MailSettings = { provider: "smtp", host: "smtp.example.com", port: 587, secure: false, user: "mailer", from: "Tugra <no-reply@example.com>", hasPassword: true, hasResendKey: false, effective: "db" };

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <EmailSettingsCard />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("EmailSettingsCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: true, email: "owner@x.io" };
    vi.spyOn(api, "getMailSettings").mockResolvedValue({ ...NONE });
    vi.spyOn(api, "updateMailSettings").mockResolvedValue({ ...SMTP });
    vi.spyOn(api, "testMailSettings").mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches", () => {
    h.user = { isInstanceOwner: false };
    wrap();
    expect(screen.queryByText("Email")).toBeNull();
    expect(api.getMailSettings).not.toHaveBeenCalled();
  });

  it("provider None shows no SMTP/Resend fields (env fallback note instead)", async () => {
    wrap();
    expect(await screen.findByText("Email")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Email is not configured/)).toBeTruthy());
    expect(screen.queryByLabelText("SMTP host")).toBeNull();
    expect(screen.queryByLabelText("Resend API key")).toBeNull();
  });

  it("choosing SMTP reveals host/port/user/password/from; saving sends them", async () => {
    wrap();
    await screen.findByText("Email");
    fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "smtp" } });
    fireEvent.change(screen.getByLabelText("SMTP host"), { target: { value: "smtp.example.com" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "2525" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "mailer" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.change(screen.getByLabelText("From address"), { target: { value: "Tugra <no-reply@example.com>" } });
    fireEvent.click(screen.getByRole("button", { name: "Save email settings" }));
    await waitFor(() =>
      expect(api.updateMailSettings).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "smtp", host: "smtp.example.com", port: 2525, user: "mailer", password: "hunter2", from: "Tugra <no-reply@example.com>" }),
      ),
    );
  });

  it("choosing Resend shows only the API key + from, and sends the key", async () => {
    wrap();
    await screen.findByText("Email");
    fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "resend" } });
    expect(screen.queryByLabelText("SMTP host")).toBeNull();
    // key required to save when none is stored
    expect(screen.getByRole("button", { name: "Save email settings" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Resend API key"), { target: { value: "re_secret" } });
    fireEvent.change(screen.getByLabelText("From address"), { target: { value: "hi@acme.io" } });
    fireEvent.click(screen.getByRole("button", { name: "Save email settings" }));
    await waitFor(() => expect(api.updateMailSettings).toHaveBeenCalledWith(expect.objectContaining({ provider: "resend", resendKey: "re_secret", from: "hi@acme.io" })));
  });

  it("never shows the stored secret: password field is empty with a 'set' hint, and blank is NOT sent", async () => {
    vi.spyOn(api, "getMailSettings").mockResolvedValue({ ...SMTP });
    wrap();
    const pw = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(pw.value).toBe("");
    expect(pw.placeholder).toMatch(/Set/);
    expect(document.body.innerHTML).not.toMatch(/hunter2|ENC\(/);
    // change a non-secret field and save: the request carries no password / resendKey at all
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Save email settings" }));
    await waitFor(() => expect(api.updateMailSettings).toHaveBeenCalled());
    const body = (api.updateMailSettings as unknown as { mock: { calls: Record<string, unknown>[][] } }).mock.calls[0][0];
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("resendKey");
    expect(body).toMatchObject({ provider: "smtp", user: "other" });
  });

  it("SMTP save is disabled until a host is given and a port is valid", async () => {
    wrap();
    await screen.findByText("Email");
    fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "smtp" } });
    expect(screen.getByRole("button", { name: "Save email settings" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("SMTP host"), { target: { value: "smtp.example.com" } });
    expect(screen.getByRole("button", { name: "Save email settings" })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "70000" } });
    expect(screen.getByRole("button", { name: "Save email settings" })).toBeDisabled();
  });

  it("Send test email defaults to the signed-in email and shows success", async () => {
    vi.spyOn(api, "getMailSettings").mockResolvedValue({ ...SMTP });
    wrap();
    await screen.findByLabelText("SMTP host");
    const to = screen.getByLabelText("Send a test email to") as HTMLInputElement;
    await waitFor(() => expect(to.value).toBe("owner@x.io"));
    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => expect(api.testMailSettings).toHaveBeenCalledWith("owner@x.io"));
    expect(await screen.findByText("Test email sent to owner@x.io")).toBeTruthy();
  });

  it("shows the failure reason when the test fails", async () => {
    vi.spyOn(api, "getMailSettings").mockResolvedValue({ ...SMTP });
    vi.spyOn(api, "testMailSettings").mockResolvedValue({ ok: false, reason: "Invalid login: ***" });
    wrap();
    await screen.findByLabelText("SMTP host");
    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByText("Test failed: Invalid login: ***")).toBeTruthy();
  });

  it("test is disabled while there are unsaved edits (the test uses the saved settings)", async () => {
    vi.spyOn(api, "getMailSettings").mockResolvedValue({ ...SMTP });
    wrap();
    await screen.findByLabelText("SMTP host"); // wait for the stored settings to seed the form
    expect(screen.getByRole("button", { name: "Send test email" })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText("SMTP host"), { target: { value: "other.example.com" } });
    expect(screen.getByRole("button", { name: "Send test email" })).toBeDisabled();
  });
});
