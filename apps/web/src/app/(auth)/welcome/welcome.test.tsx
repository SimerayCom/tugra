import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import type { PublicUser } from "../../../lib/types";

// useAuth + router are mutable per test.
const h = vi.hoisted(() => ({
  auth: { user: null as PublicUser | null, loading: false, initialized: null as boolean | null },
}));
const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => h.auth }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: nav.replace, push: nav.push }) }));

import WelcomePage from "./page";

const wrap = () => render(<I18nProvider><WelcomePage /></I18nProvider>);

describe("WelcomePage", () => {
  beforeEach(() => {
    nav.replace.mockClear();
    nav.push.mockClear();
    h.auth = { user: null, loading: false, initialized: null };
  });
  afterEach(cleanup);

  it("renders the welcome card on a fresh, logged-out install and routes the CTA to /register", () => {
    h.auth = { user: null, loading: false, initialized: false };
    wrap();
    expect(screen.getByText("Welcome to Tugra")).toBeTruthy();
    const cta = screen.getByRole("button", { name: "Create the owner account" });
    fireEvent.click(cta);
    expect(nav.push).toHaveBeenCalledWith("/register");
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("redirects to /login once the instance is already initialized", () => {
    h.auth = { user: null, loading: false, initialized: true };
    wrap();
    expect(nav.replace).toHaveBeenCalledWith("/login");
    expect(screen.queryByText("Welcome to Tugra")).toBeNull();
  });

  it("redirects a logged-in visitor to the dashboard", () => {
    h.auth = { user: { id: "u1" } as PublicUser, loading: false, initialized: true };
    wrap();
    expect(nav.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("shows a spinner (no redirect) while status is still unknown", () => {
    h.auth = { user: null, loading: false, initialized: null };
    wrap();
    expect(screen.queryByText("Welcome to Tugra")).toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
