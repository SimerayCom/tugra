import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import type { PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ auth: { user: null as PublicUser | null, loading: false, reload: vi.fn(), logout: vi.fn() } }));
const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => h.auth }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: nav.replace }) }));

import { api } from "../../../lib/api";
import TwoFactorSetupPage from "./page";

const wrap = () => render(<I18nProvider><TwoFactorSetupPage /></I18nProvider>);

describe("two-factor-setup page", () => {
  beforeEach(() => {
    nav.replace.mockClear();
    vi.spyOn(api, "setup2fa").mockResolvedValue({ otpauthUrl: "otpauth://x", qrDataUrl: "data:image/png;base64,AAAA" });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("sends a logged-out visitor to /login", () => {
    h.auth = { user: null, loading: false, reload: vi.fn(), logout: vi.fn() };
    wrap();
    expect(nav.replace).toHaveBeenCalledWith("/login");
  });

  it("sends an account that doesn't need to enrol on to its home", () => {
    h.auth = { user: { id: "u1", uiMode: "home", twoFaSetupRequired: false } as PublicUser, loading: false, reload: vi.fn(), logout: vi.fn() };
    wrap();
    expect(nav.replace).toHaveBeenCalledWith("/home");
  });

  it("shows the enrolment flow and a way out (log out) for an account that must enrol", async () => {
    h.auth = { user: { id: "u1", uiMode: "fleet", twoFaSetupRequired: true } as PublicUser, loading: false, reload: vi.fn(), logout: vi.fn() };
    wrap();
    expect(screen.getByText("Set up two-factor authentication")).toBeTruthy();
    expect(await screen.findByLabelText("2FA or recovery code")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
