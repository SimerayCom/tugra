import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { api } from "../lib/api";
import { EmptyDefaultsCard } from "./empty-defaults-card";
import { EMPTY_DEFAULTS_DISMISSED_KEY } from "../lib/empty-defaults";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><I18nProvider><ConfirmProvider><EmptyDefaultsCard /></ConfirmProvider></I18nProvider></QueryClientProvider>);
}
const candidate = (id: string) => ({ id, teamId: "t1", createdAt: "2026-01-01T00:00:00Z" });

describe("EmptyDefaultsCard", () => {
  it("shows nothing when there is no empty Default project", async () => {
    const spy = vi.spyOn(api, "listEmptyDefaultProjects").mockResolvedValue([]);
    const { container } = renderCard();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("asks first, then removes exactly the listed projects", async () => {
    vi.spyOn(api, "listEmptyDefaultProjects").mockResolvedValue([candidate("p1"), candidate("p2")]);
    const remove = vi.spyOn(api, "removeEmptyDefaultProjects").mockResolvedValue({ removed: ["p1", "p2"], skipped: [] });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(remove).not.toHaveBeenCalled(); // the confirmation comes first
    const dialogButtons = await screen.findAllByRole("button", { name: "Remove" });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(["p1", "p2"]));
  });

  it("\"Not now\" hides it for good on this browser", async () => {
    const spy = vi.spyOn(api, "listEmptyDefaultProjects").mockResolvedValue([candidate("p1")]);
    const { container } = renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(localStorage.getItem(EMPTY_DEFAULTS_DISMISSED_KEY)).toBe("1");
    expect(container.textContent).toBe("");
    cleanup();
    spy.mockClear();
    const again = renderCard();
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled(); // not even fetched once dismissed
    expect(again.container.textContent).toBe("");
  });
});
