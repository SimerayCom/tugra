import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";

const h = vi.hoisted(() => ({ reload: vi.fn(), download: vi.fn(), print: vi.fn() }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ reload: h.reload, user: null }) }));
vi.mock("../lib/recovery-codes-file", async (orig) => ({
  ...(await orig<typeof import("../lib/recovery-codes-file")>()),
  downloadTextFile: h.download,
  printHtml: h.print,
}));

import { api } from "../lib/api";
import { RecoveryCodesDialog, TwoFactorEnroll } from "./two-factor";

const wrap = (node: React.ReactNode) => render(<I18nProvider>{node}</I18nProvider>);
const codes = ["AAAA-1111", "BBBB-2222"];

beforeEach(() => {
  h.reload.mockReset().mockResolvedValue(undefined);
  h.download.mockReset();
  h.print.mockReset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RecoveryCodesDialog", () => {
  it("keeps the acknowledgement disabled until the codes were copied, downloaded or printed", async () => {
    const onClose = vi.fn();
    wrap(<RecoveryCodesDialog codes={codes} onClose={onClose} />);
    const ack = screen.getByLabelText("I've saved these codes") as HTMLInputElement;
    const done = screen.getByRole("button", { name: "Done" });
    expect(ack.disabled).toBe(true);
    expect(done).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Download (.txt)" }));
    expect(h.download).toHaveBeenCalledTimes(1);
    expect(ack.disabled).toBe(false);
    expect(done).toBeDisabled(); // still needs the explicit tick
    fireEvent.click(ack);
    expect(done).not.toBeDisabled();
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalled();
  });

  it("the downloaded file is named per hub + date and carries every code and the hub address", () => {
    wrap(<RecoveryCodesDialog codes={codes} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Download (.txt)" }));
    const [filename, text] = h.download.mock.calls[0] as [string, string];
    expect(filename).toMatch(/^tugra-recovery-codes-.+-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(text).toContain(window.location.origin);
    expect(text).toContain("AAAA-1111");
    expect(text).toContain("BBBB-2222");
  });

  it("print hands a sheet with the codes to the printer and unlocks the checkbox", () => {
    wrap(<RecoveryCodesDialog codes={codes} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(h.print).toHaveBeenCalledTimes(1);
    expect(String(h.print.mock.calls[0][0])).toContain("<li>AAAA-1111</li>");
    expect((screen.getByLabelText("I've saved these codes") as HTMLInputElement).disabled).toBe(false);
  });

  it("copy unlocks the checkbox once the clipboard write succeeds", async () => {
    wrap(<RecoveryCodesDialog codes={codes} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect((screen.getByLabelText("I've saved these codes") as HTMLInputElement).disabled).toBe(false));
  });

  it("cannot be dismissed with Escape (the codes are shown once)", () => {
    const onClose = vi.fn();
    wrap(<RecoveryCodesDialog codes={codes} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("TwoFactorEnroll", () => {
  const mockSetup = () => vi.spyOn(api, "setup2fa").mockResolvedValue({ otpauthUrl: "otpauth://x", qrDataUrl: "data:image/png;base64,AAAA" });

  it("scan → enable → codes → offers to sign out other devices → reloads once and reports done", async () => {
    mockSetup();
    const enable = vi.spyOn(api, "enable2fa").mockResolvedValue({ recoveryCodes: codes });
    const revoke = vi.spyOn(api, "revokeOtherSessions").mockResolvedValue({ ok: true });
    const onEnrolled = vi.fn();
    wrap(<TwoFactorEnroll onEnrolled={onEnrolled} />);
    fireEvent.change(await screen.findByLabelText("2FA or recovery code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(enable).toHaveBeenCalledWith("123456"));
    expect(h.reload).not.toHaveBeenCalled(); // the one-time codes are still on screen
    fireEvent.click(await screen.findByRole("button", { name: "Download (.txt)" }));
    fireEvent.click(screen.getByLabelText("I've saved these codes"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out other devices" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onEnrolled).toHaveBeenCalledTimes(1));
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("'Keep them' finishes without touching other sessions", async () => {
    mockSetup();
    vi.spyOn(api, "enable2fa").mockResolvedValue({ recoveryCodes: codes });
    const revoke = vi.spyOn(api, "revokeOtherSessions").mockResolvedValue({ ok: true });
    const onEnrolled = vi.fn();
    wrap(<TwoFactorEnroll onEnrolled={onEnrolled} />);
    fireEvent.change(await screen.findByLabelText("2FA or recovery code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    fireEvent.click(await screen.findByRole("button", { name: "Print" }));
    fireEvent.click(screen.getByLabelText("I've saved these codes"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep them" }));
    await waitFor(() => expect(onEnrolled).toHaveBeenCalled());
    expect(revoke).not.toHaveBeenCalled();
  });

  it("offerSignOutOthers=false skips the prompt (a fresh install has no other sessions)", async () => {
    mockSetup();
    vi.spyOn(api, "enable2fa").mockResolvedValue({ recoveryCodes: codes });
    const onEnrolled = vi.fn();
    wrap(<TwoFactorEnroll onEnrolled={onEnrolled} offerSignOutOthers={false} />);
    fireEvent.change(await screen.findByLabelText("2FA or recovery code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    fireEvent.click(await screen.findByRole("button", { name: "Print" }));
    fireEvent.click(screen.getByLabelText("I've saved these codes"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onEnrolled).toHaveBeenCalled());
    expect(screen.queryByText("Sign out other devices?")).toBeNull();
  });

  it("shows a wrong code inline and stays on the scan step", async () => {
    mockSetup();
    vi.spyOn(api, "enable2fa").mockRejectedValue(new Error("invalid code"));
    wrap(<TwoFactorEnroll onEnrolled={() => undefined} />);
    fireEvent.change(await screen.findByLabelText("2FA or recovery code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(await screen.findByText("invalid code")).toBeTruthy();
    expect(screen.queryByText("Your recovery codes")).toBeNull();
  });

  it("starts exactly one setup (each call mints a new secret)", async () => {
    const setup = mockSetup();
    wrap(<TwoFactorEnroll onEnrolled={() => undefined} />);
    await screen.findByLabelText("2FA or recovery code");
    expect(setup).toHaveBeenCalledTimes(1);
  });
});
