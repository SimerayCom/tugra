import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MailNotConfiguredNote, MAIL_NOTE_DISMISS_KEY } from "./mail-not-configured-note";
import { I18nProvider } from "../i18n/provider";

// Hoisted spies for the signed-in user and the cached instance status this note reads.
const mocks = vi.hoisted(() => ({
  useAuth: vi.fn((): { user: Record<string, unknown> | null } => ({ user: { isInstanceOwner: true } })),
  useQuery: vi.fn((): { data: unknown } => ({ data: { mailConfigured: false } })),
}));
vi.mock("../lib/auth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));

afterEach(() => { cleanup(); localStorage.clear(); });
const draw = (node: React.ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

describe("MailNotConfiguredNote", () => {
  it("links an owner straight to Settings → Email and shows the consequence", () => {
    mocks.useAuth.mockReturnValue({ user: { isInstanceOwner: true } });
    mocks.useQuery.mockReturnValue({ data: { mailConfigured: false } });
    const { container } = draw(<MailNotConfiguredNote consequence="Invitees won't get an email." />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/settings?tab=instance&section=email#email");
    expect(container.textContent).toContain("Invitees won't get an email.");
  });

  it("tells a non-owner to ask an administrator, with no settings link", () => {
    mocks.useAuth.mockReturnValue({ user: { isInstanceOwner: false } });
    mocks.useQuery.mockReturnValue({ data: { mailConfigured: false } });
    const { container } = draw(<MailNotConfiguredNote />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent?.toLowerCase()).toContain("administrator");
  });

  it("renders nothing when mail IS configured", () => {
    mocks.useAuth.mockReturnValue({ user: { isInstanceOwner: true } });
    mocks.useQuery.mockReturnValue({ data: { mailConfigured: true } });
    expect(draw(<MailNotConfiguredNote />).container.firstChild).toBeNull();
  });

  it("renders nothing while the status is still unknown (never a false alarm)", () => {
    mocks.useAuth.mockReturnValue({ user: { isInstanceOwner: true } });
    mocks.useQuery.mockReturnValue({ data: undefined });
    expect(draw(<MailNotConfiguredNote />).container.firstChild).toBeNull();
  });

  describe("dismissible banner", () => {
    it("can be closed, stays closed on remount, and is shared across surfaces", () => {
      mocks.useAuth.mockReturnValue({ user: { isInstanceOwner: true } });
      mocks.useQuery.mockReturnValue({ data: { mailConfigured: false } });
      const first = draw(<MailNotConfiguredNote dismissible />);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(first.container.firstChild).toBeNull();
      expect(localStorage.getItem(MAIL_NOTE_DISMISS_KEY)).toBe("1");
      first.unmount();
      expect(draw(<MailNotConfiguredNote dismissible />).container.firstChild).toBeNull();
    });

    it("a non-dismissible note ignores the stored dismissal and has no close button", () => {
      localStorage.setItem(MAIL_NOTE_DISMISS_KEY, "1");
      mocks.useAuth.mockReturnValue({ user: { isInstanceOwner: true } });
      mocks.useQuery.mockReturnValue({ data: { mailConfigured: false } });
      draw(<MailNotConfiguredNote />);
      expect(screen.getByRole("status")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    });

    it("forgets the dismissal once email is configured, so a later outage warns again", () => {
      localStorage.setItem(MAIL_NOTE_DISMISS_KEY, "1");
      mocks.useAuth.mockReturnValue({ user: { isInstanceOwner: true } });
      mocks.useQuery.mockReturnValue({ data: { mailConfigured: true } });
      draw(<MailNotConfiguredNote dismissible />);
      expect(localStorage.getItem(MAIL_NOTE_DISMISS_KEY)).toBeNull();
    });
  });
});
