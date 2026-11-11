import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MailNotConfiguredNote } from "./mail-not-configured-note";
import { I18nProvider } from "../i18n/provider";

// Hoisted spies for the signed-in user and the cached instance status this note reads.
const mocks = vi.hoisted(() => ({
  useAuth: vi.fn((): { user: Record<string, unknown> | null } => ({ user: { isInstanceOwner: true } })),
  useQuery: vi.fn((): { data: unknown } => ({ data: { mailConfigured: false } })),
}));
vi.mock("../lib/auth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));

afterEach(cleanup);
const draw = (node: React.ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

describe("MailNotConfiguredNote", () => {
  it("links an owner straight to Settings → Email and shows the consequence", () => {
    mocks.useAuth.mockReturnValue({ user: { isInstanceOwner: true } });
    mocks.useQuery.mockReturnValue({ data: { mailConfigured: false } });
    const { container } = draw(<MailNotConfiguredNote consequence="Invitees won't get an email." />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/settings?tab=instance#email");
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
});
