import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ConfirmProvider } from "../../../../components/confirm";
import { api } from "../../../../lib/api";
import type { Team } from "../../../../lib/types";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "t1" }), useRouter: () => ({ push: vi.fn(), replace: nav.replace }), usePathname: () => "/teams/t1" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("../../../../components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../../../../lib/auth", () => ({ useAuth: () => ({ user: { isInstanceOwner: true } }) }));

import TeamDetailPage from "./page";

vi.setConfig({ testTimeout: 20_000 }); // the first render of the full page is slow on a cold transform

afterEach(() => { cleanup(); vi.restoreAllMocks(); nav.replace.mockClear(); localStorage.clear(); });

const team = (over: Partial<Team> = {}): Team => ({ id: "t1", name: "Acme", role: "OWNER", memberCount: 1, iconUpdatedAt: null, color: null, ...over });

function setup(initial: Team) {
  let current = initial;
  const getTeam = vi.spyOn(api, "getTeam").mockImplementation(async () => current);
  vi.spyOn(api, "listTeamMembers").mockResolvedValue([]);
  vi.spyOn(api, "listTeamRoles").mockResolvedValue([]);
  vi.spyOn(api, "listProjects").mockResolvedValue([]);
  vi.spyOn(api, "listTeamInvitations").mockResolvedValue([]);
  vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ mailConfigured: false } as Awaited<ReturnType<typeof api.getInstanceStatus>>);
  const rename = vi.spyOn(api, "renameTeam").mockImplementation(async (_id, name) => { current = { ...current, name }; return { ok: true }; });
  const del = vi.spyOn(api, "deleteTeam").mockResolvedValue({ ok: true });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}><I18nProvider><ConfirmProvider><TeamDetailPage /></ConfirmProvider></I18nProvider></QueryClientProvider>,
  );
  return { getTeam, rename, del };
}

describe("team detail page", () => {
  beforeEach(() => { localStorage.clear(); });

  it("shows the new name straight after a rename (no hard refresh)", async () => {
    const { rename, getTeam } = setup(team());
    await screen.findByRole("heading", { level: 1, name: "Acme" });
    const input = screen.getByLabelText("Rename");
    fireEvent.change(input, { target: { value: "Globex" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(rename).toHaveBeenCalledWith("t1", "Globex"));
    await screen.findByRole("heading", { level: 1, name: "Globex" });
    expect(getTeam.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps Delete team out of the header and in a Danger zone at the bottom", async () => {
    setup(team());
    const zone = await screen.findByRole("region", { name: "Danger zone" });
    const buttons = screen.getAllByRole("button", { name: "Delete team" });
    expect(buttons).toHaveLength(1);
    expect(zone.contains(buttons[0])).toBe(true);
    // Nothing destructive sits in the page header block.
    const header = screen.getByRole("heading", { level: 1 }).parentElement!.parentElement!;
    expect(within(header).queryByRole("button", { name: "Delete team" })).toBeNull();
    // The danger zone is the last card on the page.
    const page = zone.closest("[style*='padding']")!.parentElement!;
    expect(page.lastElementChild!.contains(zone)).toBe(true);
  });

  it("requires typing the team name before the deletion goes through", async () => {
    const { del } = setup(team());
    fireEvent.click(await screen.findByRole("button", { name: "Delete team" }));
    const dialog = await screen.findByRole("dialog");
    const confirmBtn = within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Acme" } });
    expect(confirmBtn.disabled).toBe(false);
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(del).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/teams"));
  });

  it("shows no Danger zone to a non-owner", async () => {
    setup(team({ role: "ADMIN" }));
    await screen.findByRole("heading", { level: 1, name: "Acme" });
    expect(screen.queryByRole("region", { name: "Danger zone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete team" })).toBeNull();
  });

  it("shows one dismissible email banner, and no per-section repeat in the invite card", async () => {
    setup(team());
    await screen.findByRole("heading", { level: 1, name: "Acme" });
    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("Email isn't set up");
    expect(screen.getAllByText(/Email isn't set up/)).toHaveLength(1);
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Email isn't set up/)).toBeNull();
  });
});
